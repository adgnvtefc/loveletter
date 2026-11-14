// invite.js: a temporary pop-up that lets an invited person make their own account,
// choosing a password nobody else ever sees. It only shows while the post office says
// someone is invited (`node server/accounts.js invite <name>`), and never says who.
// To retire it: delete this file, its <section id="invite"> in index.html, and the
// invitePopup() call in app.js.

import { invitesOpen, claimInvite } from './account.js';

const $ = id => document.getElementById(id);

// Resolves once the pop-up is closed, or right away when nobody is invited.
export async function invitePopup() {
  if (!(await invitesOpen())) return;
  $('invite').hidden = false;
  return new Promise(resolve => {
    const close = () => { $('invite').hidden = true; resolve(); };
    $('inviteClose').addEventListener('click', close);
    $('inviteForm').addEventListener('submit', async e => {
      e.preventDefault();
      const name = $('inviteName').value, password = $('invitePassword').value;
      const error = text => { $('inviteError').textContent = text; };
      if (!name.trim()) return error('which username?');
      if (!password.trim()) return error('choose a password.');
      if (password !== $('invitePassword2').value) return error("those passwords don't match.");
      error('');
      $('inviteGo').disabled = true;
      $('inviteGo').textContent = 'making it…';
      const result = await claimInvite(name, password);
      $('inviteGo').disabled = false;
      $('inviteGo').textContent = 'create my account ♥';
      if (result === 'not-invited') return error("hmm, that username isn't on the list.");
      if (result === 'busy') return error('too many tries just now. wait a few minutes?');
      if (result === 'closed') return error("couldn't reach the post office. try again in a bit?");
      $('inviteFields').hidden = true;
      $('inviteText').textContent = `account made ♥ welcome, ${name.trim().toLowerCase()}! you're signed in. tap your name at the top left any time to see your letters.`;
      $('inviteClose').focus();
    });
  });
}
