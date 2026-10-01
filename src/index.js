import React from "react";
import ReactDOM from "react-dom";
import AppBar from "./AppBar.js";
import PdfEditor from "./PdfEditor.js";

import "./styles.css";

function App() {
  return (
    <div className="App">
      <AppBar />
      <PdfEditor />
    </div>
  );
}

const rootElement = document.getElementById("root");
ReactDOM.render(<App />, rootElement);
