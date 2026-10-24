// Copyright (C) 2026 The Qt Company Ltd.
// SPDX-License-Identifier: LicenseRef-Qt-Commercial OR LGPL-3.0-only

import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildFindsQt,
  resolveQtBridgeQtDirWithSource,
  type QtBridgeProjectInfo
} from '@/project.mjs';
import {
  checkQtDirForBuild,
  findQtQmlDir,
  resolveQtLayout
} from '@/qt-dir.mjs';

describe('Qt Bridge Qt directory for builds', () => {
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'qt-csharp-qtdir-')
    );
  });

  afterEach(async () => {
    await fs.promises.rm(testDirectory, { recursive: true, force: true });
  });

  function createQt(
    name: string,
    options: {
      arch?: string;
      msvc?: boolean;
      debugOnly?: boolean;
      cross?: boolean;
      qconfig?: string;
    } = {}
  ) {
    const qtDir = path.join(testDirectory, name);
    const write = (file: string, content = '') => {
      fs.mkdirSync(path.dirname(path.join(qtDir, file)), { recursive: true });
      fs.writeFileSync(path.join(qtDir, file), content);
    };
    write('lib/cmake/Qt6/Qt6Config.cmake');
    write(
      'mkspecs/qconfig.pri',
      options.qconfig ?? `QT_ARCH = ${options.arch ?? 'x86_64'}\n`
    );
    if (options.msvc !== false) {
      write(options.debugOnly ? 'lib/Qt6Cored.lib' : 'lib/Qt6Core.lib');
    }
    if (options.cross) {
      write('bin/target_qt.conf');
    }
    return qtDir;
  }

  it('accepts a Qt installation that matches the host', () => {
    const qtDir = createQt('msvc2022_64');
    expect(checkQtDirForBuild(qtDir, 'win32', 'x64')).to.equal(undefined);
    expect(checkQtDirForBuild(qtDir, 'linux', 'x64')).to.equal(undefined);
  });

  it('accepts a multi-architecture build that includes the host', () => {
    // The universal macOS packages list both architectures in QT_ARCHS.
    const universal = createQt('macos', {
      qconfig: 'QT_ARCH = x86_64\nQT_ARCHS = x86_64 arm64\n'
    });
    expect(checkQtDirForBuild(universal, 'darwin', 'arm64')).to.equal(
      undefined
    );
    expect(checkQtDirForBuild(universal, 'darwin', 'x64')).to.equal(undefined);

    const intelOnly = createQt('macos-x86_64', { arch: 'x86_64' });
    expect(checkQtDirForBuild(intelOnly, 'darwin', 'arm64')).to.match(
      /Qt for x86_64, but this machine is arm64/
    );
  });

  it('ignores architecture values that reference qmake variables', () => {
    const qtDir = createQt('generated', {
      qconfig: 'QT_ARCHS = $$QT_ARCH\nQT_ARCH = arm64\n'
    });
    expect(checkQtDirForBuild(qtDir, 'linux', 'arm64')).to.equal(undefined);
  });

  it('accepts a debug-only MSVC build of Qt', () => {
    const qtDir = createQt('debug', { debugOnly: true });
    expect(checkQtDirForBuild(qtDir, 'win32', 'x64')).to.equal(undefined);
  });

  it('rejects Qt installations that cannot build on the host', () => {
    expect(checkQtDirForBuild(path.join(testDirectory, 'missing'))).to.match(
      /not a Qt 6 installation/
    );
    expect(
      checkQtDirForBuild(
        createQt('msvc2022_arm64', { arch: 'arm64' }),
        'win32',
        'x64'
      )
    ).to.match(/Qt for arm64/);
    expect(
      checkQtDirForBuild(createQt('mingw_64', { msvc: false }), 'win32', 'x64')
    ).to.match(/MSVC/);
    expect(
      checkQtDirForBuild(createQt('android', { cross: true }), 'linux', 'x64')
    ).to.match(/different target/);
  });

  // A distribution Qt below <prefix>/<libDir>, with qconfig.pri and the QML
  // modules below <libDir>/qt6 instead of the prefix.
  function createDistributionQt(libDir: string, arch = 'arm64') {
    const prefix = path.join(testDirectory, 'usr');
    const write = (file: string, content = '') => {
      fs.mkdirSync(path.dirname(path.join(prefix, file)), { recursive: true });
      fs.writeFileSync(path.join(prefix, file), content);
    };
    write(`${libDir}/cmake/Qt6/Qt6Config.cmake`);
    write(`${libDir}/qt6/mkspecs/qconfig.pri`, `QT_ARCH = ${arch}\n`);
    fs.mkdirSync(path.join(prefix, libDir, 'qt6', 'qml'), { recursive: true });
    return prefix;
  }

  it('accepts the lib64 and multiarch layouts of distribution Qt', () => {
    const debian = createDistributionQt('lib/aarch64-linux-gnu');
    expect(resolveQtLayout(debian, 'linux', 'arm64')).to.deep.equal({
      prefix: debian,
      libDir: path.join(debian, 'lib', 'aarch64-linux-gnu')
    });
    expect(checkQtDirForBuild(debian, 'linux', 'arm64')).to.equal(undefined);
    // The architecture is read from <libdir>/qt6/mkspecs/qconfig.pri.
    expect(
      resolveQtLayout(debian, 'linux', 'x64'),
      'the triplet follows the host architecture'
    ).to.equal(undefined);

    fs.rmSync(debian, { recursive: true });
    const fedora = createDistributionQt('lib64', 'x86_64');
    expect(checkQtDirForBuild(fedora, 'linux', 'x64')).to.equal(undefined);
    expect(checkQtDirForBuild(fedora, 'linux', 'arm64')).to.match(
      /Qt for x86_64, but this machine is arm64/
    );
  });

  it('accepts the directory that contains Qt6Config.cmake', () => {
    const debian = createDistributionQt('lib/aarch64-linux-gnu');
    const cmakeDir = path.join(
      debian,
      'lib',
      'aarch64-linux-gnu',
      'cmake',
      'Qt6'
    );
    expect(resolveQtLayout(cmakeDir, 'linux', 'arm64')?.prefix).to.equal(
      debian
    );
    expect(
      resolveQtLayout(cmakeDir + path.sep, 'linux', 'arm64')?.prefix
    ).to.equal(debian);
    expect(checkQtDirForBuild(cmakeDir, 'linux', 'arm64')).to.equal(undefined);

    const installer = createQt('gcc_64');
    expect(
      resolveQtLayout(path.join(installer, 'lib', 'cmake', 'Qt6'))?.prefix
    ).to.equal(installer);
  });

  it('rejects directories that are not a Qt prefix or its CMake package', () => {
    const debian = createDistributionQt('lib/aarch64-linux-gnu');
    expect(
      resolveQtLayout(
        path.join(debian, 'lib', 'aarch64-linux-gnu'),
        'linux',
        'arm64'
      )
    ).to.equal(undefined);
    expect(resolveQtLayout(testDirectory, 'linux', 'arm64')).to.equal(
      undefined
    );
    // Qt6Config.cmake outside <libdir>/cmake/Qt6 has no known prefix.
    const stray = path.join(testDirectory, 'stray');
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, 'Qt6Config.cmake'), '');
    expect(resolveQtLayout(stray, 'linux', 'arm64')).to.equal(undefined);
  });

  it('finds the QML modules of installer and distribution Qt', () => {
    const installer = createQt('gcc_64');
    fs.mkdirSync(path.join(installer, 'qml'));
    expect(findQtQmlDir(installer)).to.equal(path.join(installer, 'qml'));

    // lib64 is accepted on every host, unlike the multiarch layout.
    const distribution = createDistributionQt('lib64');
    expect(findQtQmlDir(distribution)).to.equal(
      path.join(distribution, 'lib64', 'qt6', 'qml')
    );
  });

  it('reports where the Qt directory comes from', () => {
    expect(
      resolveQtBridgeQtDirWithSource(
        '/project',
        { configuredQtDir: '/setting' },
        '/env'
      )
    ).to.deep.equal({ qtDir: '/project', source: 'project' });
    expect(
      resolveQtBridgeQtDirWithSource(
        undefined,
        { configuredQtDir: '/setting' },
        '/env'
      )
    ).to.deep.equal({ qtDir: '/setting', source: 'setting' });
    expect(
      resolveQtBridgeQtDirWithSource(
        undefined,
        { selectedQtDir: '/core' },
        '/env'
      )
    ).to.deep.equal({ qtDir: '/env', source: 'environment' });
    expect(
      resolveQtBridgeQtDirWithSource(undefined, { selectedQtDir: '/core' }, ' ')
    ).to.deep.equal({ qtDir: '/core', source: 'qtCore' });
    expect(resolveQtBridgeQtDirWithSource(undefined, {}, '')).to.deep.equal({});
  });

  it('uses the prefix of a Qt CMake package directory', () => {
    const installer = createQt('gcc_64');
    expect(
      resolveQtBridgeQtDirWithSource(
        undefined,
        { configuredQtDir: path.join(installer, 'lib', 'cmake', 'Qt6') },
        ''
      )
    ).to.deep.equal({ qtDir: installer, source: 'setting' });
  });

  it('knows when a build cannot find Qt', () => {
    const project: QtBridgeProjectInfo = {
      projectFile: 'Application.csproj',
      packageId: 'QtGroup.Qt.Bridge.CSharp.linux-x64',
      packageVersion: '0.4.*-*',
      qtDir: undefined
    };
    expect(buildFindsQt(project)).to.equal(false);
    expect(buildFindsQt({ ...project, qtDirSource: 'qtCore' })).to.equal(false);
    expect(buildFindsQt({ ...project, qtDirSource: 'environment' })).to.equal(
      true
    );
    expect(buildFindsQt({ ...project, qtDirSource: 'setting' })).to.equal(true);
    expect(buildFindsQt({ ...project, hasBundledQt: true })).to.equal(true);
  });
});
