// Loaded by entry.mjs before the app's own code, so that dialogs, the system browser and relaunch are answered and recorded from the
// first moment, before the updater's launch check can open anything. Tests never open a native dialog or window.
//   OPENDOC_UPDATER_TEST_EVENTS   file the events are appended to, one JSON line each: dialog, external, relaunch
//   OPENDOC_UPDATER_TEST_ANSWERS  file holding [[regular expression for a dialog's message, button label], ...], read at each dialog
const { app, dialog, shell } = require('electron');
const fs = require('node:fs');

const events = process.env.OPENDOC_UPDATER_TEST_EVENTS;
const answers = process.env.OPENDOC_UPDATER_TEST_ANSWERS;
const record = event => { if (events) fs.appendFileSync(events, `${JSON.stringify(event)}\n`); };
const rules = () => { try { return JSON.parse(fs.readFileSync(answers, 'utf8')); } catch { return []; } };

dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  record({ kind: 'dialog', title: options.title, message: options.message, detail: options.detail, buttons: options.buttons });
  const rule = rules().find(([pattern]) => new RegExp(pattern).test(options.message));
  const index = rule ? (options.buttons ?? []).indexOf(rule[1]) : 0;
  return { response: Math.max(index, 0), checkboxChecked: false };
};
shell.openExternal = async url => { record({ kind: 'external', url }); };
app.relaunch = () => { record({ kind: 'relaunch' }); };
