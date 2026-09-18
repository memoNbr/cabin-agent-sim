import { cabinApi } from "./cabin.js";
import { init as initAvatar } from "./avatar.js";
import "./cognitive.js";
import { init as initUi } from "./ui.js";

initAvatar(cabinApi);
initUi();