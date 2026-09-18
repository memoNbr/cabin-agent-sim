import { cabinApi } from "./cabin.js";

const state = cabinApi.state;

function mirror() {
  requestAnimationFrame(mirror);
  if (cabinApi.__avatar) {
    try {
      state.avatarPose = cabinApi.__avatar.getAvatarPose();
    } catch (e) { /* headless — pose is best-effort telemetry only */ }
  }
}

export function init() {
  mirror();
  return { state: state, avatar: cabinApi.__avatar || null };
}