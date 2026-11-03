const variant = new URLSearchParams(location.search).get('home');
const sibling = (path: string) => import(new URL(path, import.meta.url).href);
if (variant === 'a' || variant === 'b' || variant === 'c') {
  document.body.classList.add('home-prototype-page');
  const main = document.querySelector('main');
  if (main) {
    main.className = '';
    main.replaceChildren();
    const host = document.createElement('div');
    host.className = 'inbox-shell';
    host.id = 'homeRoot';
    main.append(host);
    for (const href of ['/css/inbox.css', '/css/home-prototypes.css']) {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.append(link);
    }
    const [{ mountInbox }, { createInboxClient }, { fixtureInboxRpc }] = await Promise.all([import('./home/home'), import('./home/inbox'), import('./home/fixture')]);
    mountInbox(host, createInboxClient(fixtureInboxRpc()), variant);
  }
} else {
  await sibling('./home-boot.js');
  await sibling('./workspace-command-center.js');
}
