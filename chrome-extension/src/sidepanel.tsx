import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, getSavedTheme } from "./theme";
import "./base.css";
import "./design-system.css";

getSavedTheme().then(applyTheme);

createRoot(document.getElementById("root")!).render(<App ctx="sidepanel" />);
