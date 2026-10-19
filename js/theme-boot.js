// Runs in <head> before first paint: put the saved theme and Color Assist on <html>
// so css/tokens.css paints the right ground at once. js/shell.js keeps them current.
(() => {
  const root = document.documentElement;
  let theme = "dark", assist = false;
  try {
    const saved = JSON.parse(localStorage.getItem("doctorcre.visual-preferences") || "{}");
    if (saved.theme === "light" || saved.theme === "dark") theme = saved.theme;
    else if (localStorage.getItem("dealroom-theme") === "light") theme = "light";
    assist = localStorage.getItem("dealroom-color-assist") === "on";
  } catch {
    // Private browsing can deny storage; the dark first paint is still usable.
  }
  root.dataset.theme = theme;
  if (assist) root.dataset.colorAssist = "on";
})();
