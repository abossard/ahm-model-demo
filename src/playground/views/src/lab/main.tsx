import { launch } from "../kit";
import { Lab } from "./Lab";

launch("lab", "The Lab", Lab, { capabilities: { tools: { listChanged: true } } });
