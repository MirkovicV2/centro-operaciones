import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultOrcaDatabasePath } from '../orca-native-archive.mjs';

// Improvement 3 (F2): the Orca database path is resolved per platform. The Windows
// branch is verified only by simulation here; the owner must run npm test on Windows.
test('Windows keeps the historical APPDATA default and its fallback', () => {
  assert.equal(defaultOrcaDatabasePath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\owner\\AppData\\Roaming' }, home: 'C:\\Users\\owner' }),
    'C:\\Users\\owner\\AppData\\Roaming\\orca\\orchestration.db');
  assert.equal(defaultOrcaDatabasePath({ platform: 'win32', env: {}, home: 'C:\\Users\\owner' }),
    'C:\\Users\\owner\\AppData\\Roaming\\orca\\orchestration.db');
  // XDG variables never leak into the Windows path.
  assert.equal(defaultOrcaDatabasePath({ platform: 'win32', env: { APPDATA: 'D:\\Roaming', XDG_CONFIG_HOME: '/home/x/.config' }, home: 'C:\\Users\\owner' }),
    'D:\\Roaming\\orca\\orchestration.db');
});

test('Linux follows XDG_CONFIG_HOME with ~/.config as fallback and macOS uses Application Support', () => {
  assert.equal(defaultOrcaDatabasePath({ platform: 'linux', env: {}, home: '/home/user' }), '/home/user/.config/orca/orchestration.db');
  assert.equal(defaultOrcaDatabasePath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/custom/config' }, home: '/home/user' }), '/custom/config/orca/orchestration.db');
  assert.equal(defaultOrcaDatabasePath({ platform: 'linux', env: { XDG_CONFIG_HOME: '  ', APPDATA: 'C:\\x' }, home: '/home/user' }), '/home/user/.config/orca/orchestration.db');
  assert.equal(defaultOrcaDatabasePath({ platform: 'darwin', env: {}, home: '/Users/user' }), '/Users/user/Library/Application Support/orca/orchestration.db');
  assert.equal(typeof defaultOrcaDatabasePath(), 'string');
});
