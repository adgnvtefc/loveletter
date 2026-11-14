// shelf.js: the account button (top left) and its panel, on both pages.
// Signed out, the panel is a sign-in form. Signed in, it's "my letters": the ones you sent
// (and whether they've been opened) and the ones you opened. Tapping one re-reads it.

import { signedInAs, checkSignIn, signIn, signOut, myShelf } from './account.js';

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter(c => c != null));
  return el;
};
const when = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).toLowerCase();

// container: where the button and panel live. onRead(id): re-read a letter from the shelf.
export function mountAccount(container, { onRead }) {
  const button = h('button', { className: 'account-button', type: 'button' });
  const card = h('div', { className: 'box modal-card' });
  const panel = h('section', { className: 'modal', hidden: true, role: 'dialog' }, card);
  panel.setAttribute('aria-label', 'account');
  container.append(button, panel);

  const close = () => { panel.hidden = true; };
  const closeButton = () => h('button', { className: 'modal-close', type: 'button', textContent: '×', onclick: close, ariaLabel: 'close' });
  panel.addEventListener('click', e => { if (e.target === panel) close(); });

  function refresh() {
    const name = signedInAs();
    button.textContent = name ? `♥ ${name}` : 'sign in';
  }

  function showSignIn() {
    const name = h('input', { autocapitalize: 'off', autocorrect: 'off', spellcheck: false, autocomplete: 'username' });
    const password = h('input', { type: 'password', autocomplete: 'current-password' });
    const error = h('p', { className: 'error', role: 'alert' });
    const go = h('button', { className: 'btn', textContent: 'sign in' });
    const form = h('form', { className: 'modal-fields' },
      h('label', {}, 'username ', name), h('label', {}, 'password ', password), error, go);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!name.value.trim() || !password.value) return (error.textContent = 'username and password, please.');
      go.disabled = true; go.textContent = 'checking…'; error.textContent = '';
      const result = await signIn(name.value, password.value);
      go.disabled = false; go.textContent = 'sign in';
      if (result === 'ok') { refresh(); return showShelf(); }
      error.textContent = { wrong: "that username and password don't match.", busy: 'too many tries just now. wait a few minutes?' }[result]
        ?? "couldn't reach the post office. try again in a bit?";
    });
    card.replaceChildren(closeButton(), h('h2', { textContent: 'sign in' }),
      h('p', { className: 'soft', textContent: 'no account needed to read or write letters. with one, you can see the letters you sent and opened, and read them again.' }),
      form);
    panel.hidden = false;
    name.focus();
  }

  function row(letter, role) {
    const peek = letter.peek;
    const what = !peek ? 'open it once with its password to keep it here'
      : role === 'sent' ? (peek.first || (peek.photos ? `${peek.photos} photo${peek.photos > 1 ? 's' : ''}` : 'a letter'))
      : `from ${peek.from}${peek.first ? ` · ${peek.first}` : ''}`;
    const status = role === 'sent' ? (letter.opened ? 'opened ♥' : 'not opened yet') : `opened ${when(letter.first_at)}`;
    return h('li', {}, h('button', {
      type: 'button', className: 'shelf-row', disabled: !peek,
      onclick: () => { close(); onRead(letter.id); },
    }, h('span', { className: 'shelf-when', textContent: role === 'sent' ? `sent ${when(letter.sealed_at)}` : status }),
      h('span', { className: 'shelf-what', textContent: what }),
      role === 'sent' ? h('span', { className: `shelf-status${letter.opened ? ' opened' : ''}`, textContent: status }) : null));
  }

  async function showShelf() {
    const name = signedInAs();
    const out = h('button', { className: 'btn ghost', type: 'button', textContent: 'sign out', onclick: async () => { await signOut(); refresh(); close(); } });
    const lists = h('div', { className: 'shelf', textContent: 'fetching your letters…' });
    card.replaceChildren(closeButton(), h('h2', { textContent: `hi, ${name} ♥` }), lists, out);
    panel.hidden = false;
    const shelf = await myShelf();
    if (!shelf) { refresh(); return signedInAs() ? (lists.textContent = "couldn't reach the post office. try again in a bit?") : showSignIn(); }
    const list = (title, letters, role, empty) => [h('h3', { textContent: title }),
      letters.length ? h('ul', { className: 'shelf-list' }, ...letters.map(l => row(l, role))) : h('p', { className: 'soft', textContent: empty })];
    lists.replaceChildren(
      ...list('letters you sent', shelf.sent, 'sent', 'none yet. letters you seal while signed in show up here.'),
      ...list('letters you opened', shelf.opened, 'opened', 'none yet. letters you open while signed in show up here.'));
  }

  button.addEventListener('click', () => (signedInAs() ? showShelf() : showSignIn()));
  refresh();
  checkSignIn().then(refresh);
  return { refresh, hide: () => { button.hidden = true; close(); } };
}
