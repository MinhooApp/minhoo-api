(function () {
  const card = document.querySelector(".card");
  if (!card) return;

  const deepLink = JSON.parse(card.getAttribute("data-deep-link") || '""');
  const fallbackUrl = JSON.parse(card.getAttribute("data-fallback-url") || '""');
  const openButton = document.getElementById("open-app");
  const downloadButton = document.getElementById("download-app");

  if (downloadButton && fallbackUrl) {
    downloadButton.setAttribute("href", fallbackUrl);
  }

  const openApp = () => {
    if (!deepLink) {
      if (fallbackUrl) window.location.href = fallbackUrl;
      return;
    }

    const startedAt = Date.now();
    window.location.href = deepLink;

    window.setTimeout(() => {
      if (Date.now() - startedAt < 1800 && fallbackUrl) {
        window.location.href = fallbackUrl;
      }
    }, 1200);
  };

  if (openButton) {
    openButton.setAttribute("href", deepLink || fallbackUrl || "#");
    openButton.addEventListener("click", function (event) {
      event.preventDefault();
      openApp();
    });
  }

  window.setTimeout(openApp, 450);
})();
