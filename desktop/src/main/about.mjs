// The About dialog. It credits the original OpenDoc project and links to it.
import { dialog } from 'electron';
import { appVersion, displayName, originalProject } from './identity.mjs';
import { openExternal } from './session-policy.mjs';

export function aboutDetails({ version, build }) {
  const lines = [
    `Build ${build?.build ?? 'development'}${build?.commit ? ` (commit ${String(build.commit).slice(0, 12)})` : ''}`,
    '',
    `${displayName} is a desktop app built on the original ${originalProject.name} project by ${originalProject.author}.`,
    originalProject.url,
    '',
    `${originalProject.name} is released under the MIT license.`,
  ];
  return { message: `${displayName} ${version}`, detail: lines.join('\n') };
}

export async function showAbout(parent, build) {
  const { message, detail } = aboutDetails({ version: await appVersion(), build });
  const options = { type: 'info', title: `About ${displayName}`, message, detail, buttons: ['OK', `Open the ${originalProject.name} project page`], defaultId: 0, cancelId: 0, noLink: true };
  const choice = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (choice.response === 1) openExternal(originalProject.url);
}
