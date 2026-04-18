const startButton = document.getElementById("startButton");
const startMenu = document.getElementById("startMenu");
const quickToggle = document.getElementById("quickToggle");
const quickPanel = document.getElementById("quickPanel");
const calendarToggle = document.getElementById("calendarToggle");
const calendarPanel = document.getElementById("calendarPanel");
const windowButtons = document.querySelectorAll("[data-open-window]");
const appWindows = document.querySelectorAll(".app-window");
const taskbarApps = document.querySelectorAll(".taskbar-app[data-open-window]");
const desktopIcons = document.querySelectorAll(".desktop-icon");
const panels = [
  { trigger: startButton, panel: startMenu },
  { trigger: quickToggle, panel: quickPanel },
  { trigger: calendarToggle, panel: calendarPanel },
];

const setPanelState = (panel, trigger, isOpen) => {
  panel.classList.toggle("is-open", isOpen);
  panel.setAttribute("aria-hidden", String(!isOpen));

  if (trigger?.hasAttribute("aria-expanded")) {
    trigger.setAttribute("aria-expanded", String(isOpen));
  }
};

const closeOtherPanels = (currentPanel) => {
  panels.forEach(({ trigger, panel }) => {
    if (panel !== currentPanel) {
      setPanelState(panel, trigger, false);
    }
  });
};

panels.forEach(({ trigger, panel }) => {
  trigger?.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = !panel.classList.contains("is-open");
    closeOtherPanels(panel);
    setPanelState(panel, trigger, willOpen);
  });

  panel?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
});

const setActiveWindow = (targetWindow) => {
  appWindows.forEach((windowElement) => {
    const isActive = windowElement.dataset.window === targetWindow;
    windowElement.classList.toggle("is-active", isActive);
  });

  taskbarApps.forEach((button) => {
    const isActive = button.dataset.openWindow === targetWindow;
    button.classList.toggle("is-active", isActive);
  });

  desktopIcons.forEach((icon) => {
    const isActive = icon.dataset.openWindow === targetWindow;
    icon.classList.toggle("is-selected", isActive);
  });
};

windowButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const targetWindow = button.dataset.openWindow;

    if (!targetWindow) {
      return;
    }

    setActiveWindow(targetWindow);
    closeOtherPanels();
    setPanelState(startMenu, startButton, false);
  });
});

document.addEventListener("click", () => {
  closeOtherPanels();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeOtherPanels();
  }
});

setActiveWindow("explorer");
setPanelState(startMenu, startButton, false);
setPanelState(quickPanel, quickToggle, false);
setPanelState(calendarPanel, calendarToggle, false);
