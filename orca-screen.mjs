// What an agent TUI looks like when it has stopped to ask a person something (Claude Code and Codex approval dialogs).
// Used to avoid typing into a prompt and to tell the person that a terminal is waiting for them. A heuristic over the
// visible screen: it can miss a dialog it does not know, so its absence proves nothing.
const DIALOG = /Esc to cancel|Do you want to |Allow this |Yes, and |No, and |\(y\/n\)|Press Enter to continue|❯ 1\. |Allow command\?|Approve\?/i;
export function dialogOnScreen(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return DIALOG.test(text);
}
