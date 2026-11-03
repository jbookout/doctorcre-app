import { bootInbox } from './home/boot';

const root = document.querySelector<HTMLElement>('#homeRoot[data-inbox]');
const variant = new URLSearchParams(location.search).get('home');
if (root && (variant === 'a' || variant === 'b' || variant === 'c')) {
  document.body.classList.add('home-prototype-page');
  const [{ mountInbox }, { createInboxClient }, { fixtureInboxRpc }] = await Promise.all([import('./home/home'), import('./home/inbox'), import('./home/fixture')]);
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/css/home-prototypes.css'; document.head.append(link);
  mountInbox(root, createInboxClient(fixtureInboxRpc()), variant);
} else if (root) void bootInbox(root);
