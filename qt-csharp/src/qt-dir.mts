// Copyright (C) 2026 The Qt Company Ltd.
// SPDX-License-Identifier: LicenseRef-Qt-Commercial OR LGPL-3.0-only

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CoreKey,
  createLogger,
  findQtKits,
  resolveConfiguration,
  type CoreAPI,
  type QtAdditionalPath
} from 'qt-lib';
import { EXTENSION_ID } from '@/constants.js';

const logger = createLogger('qt-dir');

const QT_DIR_SETTING = 'qtDir';
const QT_DIR_VARIABLE = 'QtDir';

// Debian multiarch triplets, as QtLinuxMultiarch in Qt.Bridge.props.
const LINUX_MULTIARCH: Partial<Record<string, string>> = {
  x64: 'x86_64-linux-gnu',
  arm64: 'aarch64-linux-gnu'
};

/**
 * The installation prefix of a Qt installation and its library directory,
 * which contains cmake/Qt6/Qt6Config.cmake.
 */
export interface QtLayout {
  readonly prefix: string;
  readonly libDir: string;
}

/**
 * Library directories below a Qt prefix that may contain the Qt CMake package,
 * as QtBridgeResolveQtLayout in Qt.Bridge.targets: lib for the Qt installer,
 * lib64 for Fedora and openSUSE, and lib/<multiarch triplet> for Debian and
 * Ubuntu.
 */
function qtLibDirNames(platform: NodeJS.Platform, arch: string) {
  const names = ['lib', 'lib64'];
  const triplet = platform === 'linux' ? LINUX_MULTIARCH[arch] : undefined;
  if (triplet) {
    names.push(path.join('lib', triplet));
  }
  return names;
}

/**
 * Resolve the layout of a Qt installation from its prefix, or from the
 * directory that contains Qt6Config.cmake, which users of distribution Qt
 * often select. Returns undefined if dir is neither.
 */
export function resolveQtLayout(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): QtLayout | undefined {
  const names = qtLibDirNames(platform, arch);
  for (const name of names) {
    if (
      fs.existsSync(path.join(dir, name, 'cmake', 'Qt6', 'Qt6Config.cmake'))
    ) {
      return { prefix: dir, libDir: path.join(dir, name) };
    }
  }
  if (!fs.existsSync(path.join(dir, 'Qt6Config.cmake'))) {
    return undefined;
  }
  const cmakeDir = path.resolve(dir);
  for (const name of names) {
    // The prefix is above <libdir>/cmake/Qt6.
    const levels = name.split(path.sep).length + 2;
    const prefix = path.resolve(cmakeDir, ...Array<string>(levels).fill('..'));
    if (path.join(prefix, name, 'cmake', 'Qt6') === cmakeDir) {
      return { prefix, libDir: path.join(prefix, name) };
    }
  }
  return undefined;
}

/**
 * Return the installation prefix of the Qt installation at qtDir, which may
 * also be the directory that contains Qt6Config.cmake, or qtDir itself if it
 * is not a Qt installation.
 */
export function resolveQtPrefix(qtDir: string) {
  return resolveQtLayout(qtDir)?.prefix ?? qtDir;
}

/**
 * Return the directory with the QML modules of a Qt installation. Distribution
 * packages keep them below <libdir>/qt6 instead of the prefix.
 */
export function findQtQmlDir(qtDir: string) {
  const layout = resolveQtLayout(qtDir);
  const candidates = layout
    ? [path.join(layout.prefix, 'qml'), path.join(layout.libDir, 'qt6', 'qml')]
    : [path.join(qtDir, 'qml')];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Read the architectures a Qt installation was built for, with the same
 * precedence as getArchInfoFromQtInfo: QT_TARGET_ARCH, then QT_ARCHS, which
 * lists all architectures of a multi-architecture build such as the
 * universal macOS packages, then QT_ARCH. Distribution packages keep
 * qconfig.pri below <libdir>/qt6 instead of the prefix.
 */
function readQtArchs(layout: QtLayout): string[] | undefined {
  let qconfig: string | undefined;
  for (const file of [
    path.join(layout.prefix, 'mkspecs', 'qconfig.pri'),
    path.join(layout.libDir, 'qt6', 'mkspecs', 'qconfig.pri')
  ]) {
    try {
      qconfig = fs.readFileSync(file, 'utf8');
      break;
    } catch {
      // Try the next location.
    }
  }
  if (qconfig === undefined) {
    return undefined;
  }
  const content = qconfig;
  const valueOf = (key: string) => {
    const value = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm')
      .exec(content)?.[1]
      ?.trim();
    // Skip values that reference other qmake variables.
    return value && !value.includes('$$') ? value : undefined;
  };
  const archs =
    valueOf('QT_TARGET_ARCH') ?? valueOf('QT_ARCHS') ?? valueOf('QT_ARCH');
  return archs?.split(/\s+/);
}

function hostQtArch(arch: string) {
  return arch === 'x64' ? 'x86_64' : arch;
}

/**
 * Check whether a Qt installation can be used to build a Qt Bridge project on
 * this host. Returns the reason why not, or undefined if it can be used.
 */
export function checkQtDirForBuild(
  qtDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | undefined {
  const layout = resolveQtLayout(qtDir, platform, arch);
  if (!layout) {
    return (
      'not a Qt 6 installation (Qt6Config.cmake is missing from ' +
      'lib/cmake/Qt6, lib64/cmake/Qt6, and lib/<multiarch triplet>/cmake/Qt6)'
    );
  }
  if (fs.existsSync(path.join(layout.prefix, 'bin', 'target_qt.conf'))) {
    return 'Qt for a different target platform';
  }
  const qtArchs = readQtArchs(layout);
  if (qtArchs && !qtArchs.includes(hostQtArch(arch))) {
    return `Qt for ${qtArchs.join(', ')}, but this machine is ${hostQtArch(arch)}`;
  }
  // MSVC builds have import libraries, Qt6Cored.lib for debug-only builds.
  // MinGW builds have libQt6Core.a instead.
  if (
    platform === 'win32' &&
    !['Qt6Core.lib', 'Qt6Cored.lib'].some((lib) =>
      fs.existsSync(path.join(layout.libDir, lib))
    )
  ) {
    return 'not an MSVC build of Qt';
  }
  return undefined;
}

export interface QtDirCandidate {
  readonly qtDir: string;
  readonly origin: string;
}

function qtDirFromQtPaths(coreApi: CoreAPI, qtPathsExe: string | undefined) {
  if (!qtPathsExe) {
    return undefined;
  }
  try {
    return coreApi.getQtInfoFromPath(qtPathsExe).info?.get('QT_INSTALL_PREFIX');
  } catch {
    return undefined;
  }
}

/**
 * Collect the Qt installations known to Qt Core that can build a Qt Bridge
 * project on this host: the selected Qt, the installations below the Qt
 * installation root, and the additional Qt paths.
 */
export async function findQtDirCandidates(
  coreApi: CoreAPI | undefined,
  folder: vscode.WorkspaceFolder | undefined
): Promise<QtDirCandidate[]> {
  if (!coreApi) {
    return [];
  }
  const scopes: (vscode.WorkspaceFolder | string)[] = folder
    ? [folder, CoreKey.GLOBAL_WORKSPACE]
    : [CoreKey.GLOBAL_WORKSPACE];
  const getValue = <T,>(key: string) =>
    scopes
      .map((scope) => coreApi.getValue<T>(scope, key))
      .find((value) => value !== undefined);

  const candidates: QtDirCandidate[] = [];
  const selected = qtDirFromQtPaths(
    coreApi,
    getValue<string>(CoreKey.SELECTED_QT_PATHS)
  );
  if (selected) {
    candidates.push({ qtDir: selected, origin: 'selected in Qt Core' });
  }
  const root = getValue<string>(CoreKey.QT_INSTALLATION_ROOT);
  for (const qtDir of root ? await findQtKits(root) : []) {
    candidates.push({ qtDir, origin: 'Qt installation root' });
  }
  for (const additional of getValue<QtAdditionalPath[]>(
    CoreKey.ADDITIONAL_QT_PATHS
  ) ?? []) {
    const qtDir = qtDirFromQtPaths(coreApi, additional.path);
    if (qtDir) {
      candidates.push({ qtDir, origin: 'additional Qt path' });
    }
  }

  const seen = new Set<string>();
  return candidates.filter(({ qtDir }) => {
    const key = path.resolve(qtDir).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    const reason = checkQtDirForBuild(qtDir);
    if (reason) {
      logger.info(`Skipping Qt candidate ${qtDir}: ${reason}`);
    }
    return reason === undefined;
  });
}

/**
 * Let the user pick the Qt installation for Qt Bridge projects and store it
 * in the qt-csharp.qtDir user setting.
 */
export async function selectQtDir(
  coreApi: CoreAPI | undefined,
  folder: vscode.WorkspaceFolder | undefined
): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { qtDir?: string };
  const candidates = await findQtDirCandidates(coreApi, folder);
  const items: Item[] = candidates.map(({ qtDir, origin }) => ({
    label: path.basename(path.dirname(qtDir)) + ' ' + path.basename(qtDir),
    description: origin,
    detail: qtDir,
    qtDir
  }));
  items.push({
    label: '$(folder-opened) Browse...',
    detail:
      'Select the Qt installation prefix, or the folder that contains Qt6Config.cmake'
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Qt Bridge C#: Select the Qt installation to build with',
    placeHolder:
      candidates.length > 0
        ? 'Qt installations known to Qt Core that match this machine'
        : 'No matching Qt installation is registered in Qt Core'
  });
  if (!picked) {
    return undefined;
  }

  let qtDir = picked.qtDir;
  if (!qtDir) {
    const folders = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: 'Select the Qt installation'
    });
    qtDir = folders?.[0]?.fsPath;
    if (!qtDir) {
      return undefined;
    }
    const reason = checkQtDirForBuild(qtDir);
    if (reason) {
      void vscode.window.showErrorMessage(
        `Cannot use ${qtDir} for Qt Bridge C#: ${reason}.`
      );
      return undefined;
    }
    // Store the prefix, which all Qt Bridge packages accept as QtDir.
    qtDir = resolveQtPrefix(qtDir);
  }

  await vscode.workspace
    .getConfiguration(EXTENSION_ID)
    .update(QT_DIR_SETTING, qtDir, vscode.ConfigurationTarget.Global);
  logger.info(`Selected Qt for Qt Bridge projects: ${qtDir}`);
  return qtDir;
}

/**
 * VS Code sets the environment only when a terminal starts, so terminals that
 * are already open keep the previous QtDir. VS Code marks them, but the mark
 * is easy to miss.
 */
function notifyOpenTerminals() {
  if (vscode.window.terminals.length === 0) {
    return;
  }
  void vscode.window.showInformationMessage(
    'The Qt installation for Qt Bridge C# applies to new terminals. ' +
      'Terminals that are already open keep the previous QtDir until you ' +
      'relaunch them.'
  );
}

/**
 * Export the qt-csharp.qtDir setting as QtDir to the integrated terminal, so
 * that builds started there use the same Qt as the extensions.
 */
export class QtDirTerminalEnvironment implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly collection: vscode.GlobalEnvironmentVariableCollection
  ) {
    this.update();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${EXTENSION_ID}.${QT_DIR_SETTING}`)) {
          this.update();
          notifyOpenTerminals();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.update();
      })
    );
  }

  private update() {
    this.collection.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const scoped = this.collection.getScoped({ workspaceFolder: folder });
      scoped.clear();
      const configured = vscode.workspace
        .getConfiguration(EXTENSION_ID, folder.uri)
        .get<string>(QT_DIR_SETTING)
        ?.trim();
      if (!configured) {
        continue;
      }
      // A Qt CMake package directory is exported as its prefix, which older
      // Qt Bridge packages require.
      const qtDir = resolveQtPrefix(resolveConfiguration(configured));
      scoped.description = `QtDir from the ${EXTENSION_ID}.${QT_DIR_SETTING} setting`;
      scoped.replace(QT_DIR_VARIABLE, qtDir);
      logger.info(`Exporting QtDir=${qtDir} to terminals of ${folder.name}`);
    }
  }

  dispose() {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
