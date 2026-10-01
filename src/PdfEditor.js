import React, { Component } from "react";

export default class PdfEditor extends Component {
  state = { file: null, rows: [{ find: "", replace: "" }], busy: false, msg: "" };

  setRow = (i, key, value) =>
    this.setState(s => ({
      rows: s.rows.map((r, j) => (j === i ? { ...r, [key]: value } : r))
    }));

  addRow = () => this.setState(s => ({ rows: [...s.rows, { find: "", replace: "" }] }));

  toBase64 = file =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  submit = async () => {
    const { file, rows } = this.state;
    if (!file) return this.setState({ msg: "Choose a PDF first." });
    this.setState({ busy: true, msg: "" });
    try {
      const res = await fetch("/api/edit-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf: await this.toBase64(file), replacements: rows })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      const bin = atob(data.pdf);
      const arr = Uint8Array.from(bin, c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([arr], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "edited-" + file.name;
      a.click();
      this.setState({ msg: `Done: ${data.count} replacement(s).` });
    } catch (e) {
      this.setState({ msg: e.message });
    } finally {
      this.setState({ busy: false });
    }
  };

  render() {
    const { rows, busy, msg } = this.state;
    return (
      <div style={{ maxWidth: 560, margin: "24px auto", padding: 16 }}>
        <input type="file" accept="application/pdf" onChange={e => this.setState({ file: e.target.files[0] })} />
        {rows.map((r, i) => (
          <div key={i} style={{ marginTop: 12 }}>
            <input placeholder="Find" value={r.find} onChange={e => this.setRow(i, "find", e.target.value)} />
            {" → "}
            <input placeholder="Replace with" value={r.replace} onChange={e => this.setRow(i, "replace", e.target.value)} />
          </div>
        ))}
        <p>
          <button onClick={this.addRow}>+ Add replacement</button>{" "}
          <button onClick={this.submit} disabled={busy}>{busy ? "Working…" : "Edit PDF"}</button>
        </p>
        <p>{msg}</p>
      </div>
    );
  }
}
