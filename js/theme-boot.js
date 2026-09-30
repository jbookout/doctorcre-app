// Resolve the saved Deal Room preference before either navigation or board paints.
try {
  if (localStorage.getItem("dealroom-theme") === "light") {
    document.body.classList.remove("night");
  }
} catch {
  // Private browsing can deny storage; the dark first paint is still usable.
}
