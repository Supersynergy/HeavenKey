const form = document.getElementById("open-form");
const portInput = document.getElementById("port");
const status = document.getElementById("status");
const extension = globalThis.browser || globalThis.chrome;

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  try {
    await extension.tabs.create({ url: `http://localhost:${port}/` });
    status.textContent = "HeavenKey ist in einem neuen Tab geöffnet.";
  } catch (error) {
    status.textContent = `Tab konnte nicht geöffnet werden: ${error.message}`;
  }
});
