export async function read(url) { return (await fetch(url)).json(); }
