const returnTo = new URL(location.href).searchParams.get("return_to");
const login = document.querySelector('a[href="/auth/login"]');
if (returnTo && /^\/a\/al1_[A-Za-z0-9_-]{1,120}$/.test(returnTo) && login instanceof HTMLAnchorElement) {
  login.href = `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}
