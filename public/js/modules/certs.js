/**
 * Certificate download button + install-guide modal.
 * Detects the visitor's OS to surface the right CA file and instructions.
 */
import { state } from "./state.js";

export function detectPlatform() {
  const ua = navigator.userAgent;
  const platform = (navigator.platform || "").toLowerCase();

  if (/iphone|ipad|ipod/i.test(ua)) {
    return {
      os: "ios",
      label: "iOS",
      icon: "📱",
      certUrl: "/__admin/proxy/ca.cer",
      certFilename: "ir-proxy-ca.cer",
      certExt: ".cer",
    };
  }
  if (/android/i.test(ua)) {
    return {
      os: "android",
      label: "Android",
      icon: "🤖",
      certUrl: "/__admin/proxy/ca.pem",
      certFilename: "ir-proxy-ca.pem",
      certExt: ".pem",
    };
  }
  if (/win/i.test(platform) || /windows/i.test(ua)) {
    return {
      os: "windows",
      label: "Windows",
      icon: "🪟",
      certUrl: "/__admin/proxy/ca.pem",
      certFilename: "ir-proxy-ca.pem",
      certExt: ".pem",
    };
  }
  // macOS, Linux, etc.
  return {
    os: "macos",
    label: "macOS",
    icon: "🍎",
    certUrl: "/__admin/proxy/ca.pem",
    certFilename: "ir-proxy-ca.pem",
    certExt: ".pem",
  };
}

// All platforms metadata for the dropdown
const ALL_PLATFORMS = [
  {
    os: "macos",
    label: "macOS",
    icon: "🍎",
    certUrl: "/__admin/proxy/ca.pem",
    certExt: ".pem",
  },
  {
    os: "ios",
    label: "iOS",
    icon: "📱",
    certUrl: "/__admin/proxy/ca.cer",
    certExt: ".cer",
  },
  {
    os: "android",
    label: "Android",
    icon: "🤖",
    certUrl: "/__admin/proxy/ca.pem",
    certExt: ".pem",
  },
  {
    os: "windows",
    label: "Windows",
    icon: "🪟",
    certUrl: "/__admin/proxy/ca.pem",
    certExt: ".pem",
  },
];

export function renderCertButton() {
  const detected = detectPlatform();
  // Update main button
  document.getElementById("cert-platform-icon").textContent = detected.icon;
  document.getElementById("cert-platform-label").textContent = detected.label;

  // Render dropdown items: detected platform first (highlighted), then others
  const others = ALL_PLATFORMS.filter((p) => p.os !== detected.os);
  const items = [{ ...detected, primary: true }, ...others];

  document.getElementById("cert-dropdown-items").innerHTML = items
    .map(
      (p) => `
    <a class="cert-dropdown-item ${p.primary ? "primary" : ""}"
       href="${p.certUrl}" download
       onclick="closeCertDropdown()">
      <span class="di-icon">${p.icon}</span>
      <span class="di-info">
        <span class="di-label">${p.label}${p.primary ? " — your device" : ""}</span>
        <span class="di-sub">${p.certExt} · ${p.certUrl.split("/").pop()}</span>
      </span>
    </a>`
    )
    .join("");
}

export function toggleCertDropdown(e) {
  e.stopPropagation();
  const wrapper = document.getElementById("cert-btn-wrapper");
  wrapper.classList.toggle("open");
}
export function closeCertDropdown() {
  document.getElementById("cert-btn-wrapper").classList.remove("open");
}

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (!document.getElementById("cert-btn-wrapper").contains(e.target)) {
    closeCertDropdown();
  }
});

// ── Install Guide Modal ──────────────────────────────────────────
export function openInstallGuide(platform) {
  const targetPlatform = platform || detectPlatform().os;
  document.getElementById("install-guide-modal").style.display = "flex";
  switchGuideTab(targetPlatform);
  closeCertDropdown();

  // Populate proxy info if available
  if (state.proxyStatus) {
    const ip = state.proxyStatus.localIPs?.[0] || "—";
    const port = window.location.port || "8888";
    document.getElementById("guide-proxy-ip").textContent = ip;
    document.getElementById("guide-proxy-port").textContent = port;

    // Update iOS URL with actual IP
    const iosUrl = document.getElementById("guide-ios-url");
    if (iosUrl) {
      iosUrl.textContent = `http://${ip}:${port}/__admin/proxy/ca.cer`;
    }
  }
}
export function closeInstallGuide() {
  document.getElementById("install-guide-modal").style.display = "none";
}

export function switchGuideTab(platform) {
  // Update tabs
  document.querySelectorAll(".guide-platform-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.id === `guide-tab-${platform}`);
  });
  // Update panels
  document.querySelectorAll(".guide-platform-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `guide-panel-${platform}`);
  });
}
