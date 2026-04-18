// PixelFoxx sidepanel — skeleton.
//
// Real implementation gets built against pixelfoxx_ui_design_system/.
// This file just confirms the extension loads and the sidepanel renders.

const API_BASE = "http://localhost:8000";

document.addEventListener("DOMContentLoaded", async () => {
  console.log("[pixelfoxx] sidepanel boot");
  try {
    const resp = await fetch(`${API_BASE}/health`);
    const data = await resp.json();
    console.log("[pixelfoxx] backend:", data);
  } catch (err) {
    console.warn("[pixelfoxx] backend unreachable:", err.message);
  }
});
