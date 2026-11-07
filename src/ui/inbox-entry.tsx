import './home/mail-priorities-start';
import { bootInbox } from './home/boot';

const root = document.querySelector<HTMLElement>('#homeRoot[data-inbox]');
if (root) void bootInbox(root);
