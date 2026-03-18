const { RecordingRoleController } = require('../src/services/recording-role.controller');

describe('RecordingRoleController', () => {
  test('defaults to interviewer and toggles while shortcut is pressed', () => {
    const controller = new RecordingRoleController({
      defaultRole: 'interviewer',
      alternateRole: 'interviewee',
      shortcut: 'CommandOrControl+B'
    });

    expect(controller.getCurrentRole()).toBe('interviewer');

    controller.handleShortcutPress('test');
    expect(controller.getCurrentRole()).toBe('interviewee');

    controller.handleShortcutRelease('test');
    expect(controller.getCurrentRole()).toBe('interviewer');
  });

  test('ignores duplicate press/release transitions', () => {
    const controller = new RecordingRoleController();
    expect(controller.handleShortcutPress('test')).toBe(true);
    expect(controller.handleShortcutPress('test')).toBe(false);
    expect(controller.handleShortcutRelease('test')).toBe(true);
    expect(controller.handleShortcutRelease('test')).toBe(false);
  });

  test('detects shortcut conflicts', () => {
    const controller = new RecordingRoleController({ shortcut: 'CommandOrControl+B' });
    expect(controller.detectShortcutConflict(['CommandOrControl+B', 'Alt+R'])).toBe(true);
    expect(controller.detectShortcutConflict(['CommandOrControl+Shift+V'])).toBe(false);
  });
});
