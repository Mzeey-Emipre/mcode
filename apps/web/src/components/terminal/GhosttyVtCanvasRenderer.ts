const SUCCESS = 0;
const OUT_OF_SPACE = -3;
const DATA_DIRTY = 3;
const DATA_ROW_ITERATOR = 4;
const ROW_DATA_DIRTY = 1;
const ROW_DATA_CELLS = 3;
const CELL_DATA_GRAPHEMES_UTF8 = 9;
const CELL_DATA_BG_COLOR = 5;
const CELL_DATA_FG_COLOR = 6;
const ROW_OPTION_DIRTY = 0;
const STATE_OPTION_DIRTY = 0;
const TERMINAL_OPTION_COLOR_FOREGROUND = 11;
const TERMINAL_OPTION_COLOR_BACKGROUND = 12;
const DEFAULT_FOREGROUND = [241, 245, 249] as const;
const DEFAULT_BACKGROUND = [16, 20, 29] as const;

type GhosttyExports = {
  readonly memory: WebAssembly.Memory;
  readonly ghostty_type_json: () => number;
  readonly ghostty_wasm_alloc_opaque: () => number;
  readonly ghostty_wasm_free_opaque: (pointer: number) => void;
  readonly ghostty_wasm_alloc_u8_array: (length: number) => number;
  readonly ghostty_wasm_free_u8_array: (pointer: number, length: number) => void;
  readonly ghostty_terminal_new: (
    allocator: number,
    outTerminal: number,
    cols: number,
    rows: number,
  ) => number;
  readonly ghostty_terminal_free: (terminal: number) => void;
  readonly ghostty_terminal_resize: (
    terminal: number,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ) => number;
  readonly ghostty_terminal_set: (
    terminal: number,
    option: number,
    value: number,
  ) => number;
  readonly ghostty_terminal_vt_write: (
    terminal: number,
    data: number,
    length: number,
  ) => void;
  readonly ghostty_render_state_new: (
    allocator: number,
    outState: number,
  ) => number;
  readonly ghostty_render_state_free: (state: number) => void;
  readonly ghostty_render_state_update: (state: number, terminal: number) => number;
  readonly ghostty_render_state_get: (
    state: number,
    data: number,
    out: number,
  ) => number;
  readonly ghostty_render_state_set: (
    state: number,
    option: number,
    value: number,
  ) => number;
  readonly ghostty_render_state_row_iterator_new: (
    allocator: number,
    outIterator: number,
  ) => number;
  readonly ghostty_render_state_row_iterator_free: (iterator: number) => void;
  readonly ghostty_render_state_row_iterator_next: (iterator: number) => number;
  readonly ghostty_render_state_row_get: (
    iterator: number,
    data: number,
    out: number,
  ) => number;
  readonly ghostty_render_state_row_set: (
    iterator: number,
    option: number,
    value: number,
  ) => number;
  readonly ghostty_render_state_row_cells_new: (
    allocator: number,
    outCells: number,
  ) => number;
  readonly ghostty_render_state_row_cells_free: (cells: number) => void;
  readonly ghostty_render_state_row_cells_next: (cells: number) => number;
  readonly ghostty_render_state_row_cells_get: (
    cells: number,
    data: number,
    out: number,
  ) => number;
};

type GhosttyTypeLayout = {
  readonly [structName: string]: {
    readonly size: number;
    readonly fields: {
      readonly [fieldName: string]: { readonly offset: number };
    };
  };
};

/** Public state exposed by the real libghostty-vt Canvas renderer. */
export interface GhosttyVtCanvasSnapshot {
  readonly dirtyRows: number;
  readonly renderCount: number;
  readonly text: string;
}

function requiredExport(
  exports: WebAssembly.Exports,
  name: keyof GhosttyExports,
): unknown {
  const value = exports[name];
  if (value === undefined) {
    throw new Error(`libghostty-vt WASM is missing export ${name}`);
  }
  return value;
}

function asGhosttyExports(exports: WebAssembly.Exports): GhosttyExports {
  const names: readonly (keyof GhosttyExports)[] = [
    "memory",
    "ghostty_type_json",
    "ghostty_wasm_alloc_opaque",
    "ghostty_wasm_free_opaque",
    "ghostty_wasm_alloc_u8_array",
    "ghostty_wasm_free_u8_array",
    "ghostty_terminal_new",
    "ghostty_terminal_free",
    "ghostty_terminal_resize",
    "ghostty_terminal_set",
    "ghostty_terminal_vt_write",
    "ghostty_render_state_new",
    "ghostty_render_state_free",
    "ghostty_render_state_update",
    "ghostty_render_state_get",
    "ghostty_render_state_set",
    "ghostty_render_state_row_iterator_new",
    "ghostty_render_state_row_iterator_free",
    "ghostty_render_state_row_iterator_next",
    "ghostty_render_state_row_get",
    "ghostty_render_state_row_set",
    "ghostty_render_state_row_cells_new",
    "ghostty_render_state_row_cells_free",
    "ghostty_render_state_row_cells_next",
    "ghostty_render_state_row_cells_get",
  ];
  for (const name of names) requiredExport(exports, name);
  return exports as unknown as GhosttyExports;
}

function readHandle(exports: GhosttyExports, pointer: number): number {
  return new DataView(exports.memory.buffer).getUint32(pointer, true);
}

function readU32(exports: GhosttyExports, pointer: number): number {
  return new DataView(exports.memory.buffer).getUint32(pointer, true);
}

function writeU8(exports: GhosttyExports, pointer: number, value: number): void {
  new DataView(exports.memory.buffer).setUint8(pointer, value);
}

function writeU32(exports: GhosttyExports, pointer: number, value: number): void {
  new DataView(exports.memory.buffer).setUint32(pointer, value, true);
}

function readColor(exports: GhosttyExports, pointer: number): string {
  const bytes = new Uint8Array(exports.memory.buffer, pointer, 3);
  return `rgb(${bytes[0]}, ${bytes[1]}, ${bytes[2]})`;
}

/** Real libghostty-vt terminal state plus a dirty-row Canvas renderer. */
export class GhosttyVtCanvasRenderer {
  private readonly exports: GhosttyExports;
  private readonly terminal: number;
  private readonly renderState: number;
  private readonly rowIterator: number;
  private rowCells: number | null = null;
  private readonly scratchPointer: number;
  private readonly rowOutputPointer: number;
  private readonly cellsOutputPointer: number;
  private readonly backgroundColorPointer: number;
  private readonly foregroundColorPointer: number;
  private readonly bufferPointer: number;
  private readonly typeLayout: GhosttyTypeLayout;
  private bufferDataPointer: number;
  private bufferDataCapacity = 128;
  private rows: string[];
  private cols: number;
  private rowCount: number;
  private cellWidth = 9;
  private cellHeight = 18;
  private dirtyRows = 0;
  private renderCount = 0;
  private forceRedraw = true;

  private constructor(
    exports: GhosttyExports,
    typeLayout: GhosttyTypeLayout,
    terminal: number,
    renderState: number,
    cols: number,
    rows: number,
  ) {
    this.exports = exports;
    this.typeLayout = typeLayout;
    this.terminal = terminal;
    this.renderState = renderState;
    this.cols = cols;
    this.rowCount = rows;
    this.rows = Array.from({ length: rows }, () => "");
    this.forceRedraw = true;
    this.scratchPointer = exports.ghostty_wasm_alloc_u8_array(4);
    this.backgroundColorPointer = exports.ghostty_wasm_alloc_u8_array(3);
    this.foregroundColorPointer = exports.ghostty_wasm_alloc_u8_array(3);
    this.bufferPointer = exports.ghostty_wasm_alloc_u8_array(
      typeLayout.GhosttyBuffer.size,
    );
    this.bufferDataPointer = exports.ghostty_wasm_alloc_u8_array(
      this.bufferDataCapacity,
    );
    this.setBuffer();
    const iteratorPointer = exports.ghostty_wasm_alloc_opaque();
    const iteratorResult = exports.ghostty_render_state_row_iterator_new(
      0,
      iteratorPointer,
    );
    this.rowIterator = readHandle(exports, iteratorPointer);
    exports.ghostty_wasm_free_opaque(iteratorPointer);
    if (iteratorResult !== SUCCESS || this.rowIterator === 0) {
      throw new Error(
        `ghostty_render_state_row_iterator_new failed with result ${iteratorResult}`,
      );
    }
    this.rowOutputPointer = exports.ghostty_wasm_alloc_opaque();
    this.cellsOutputPointer = exports.ghostty_wasm_alloc_opaque();
  }

  /** Load and initialize the vendored libghostty-vt WASM module. */
  static async create(cols: number, rows: number): Promise<GhosttyVtCanvasRenderer> {
    const response = await fetch("/prototypes/ghostty-vt.wasm");
    if (!response.ok) {
      throw new Error(`libghostty-vt WASM request failed (${response.status})`);
    }
    const bytes = await response.arrayBuffer();
    const instantiated = await WebAssembly.instantiate(bytes, {
      env: { log: () => undefined },
    });
    const exports = asGhosttyExports(instantiated.instance.exports);
    const typeJsonPointer = exports.ghostty_type_json();
    const typeJson = new TextDecoder().decode(
      new Uint8Array(exports.memory.buffer, typeJsonPointer),
    ).split("\0", 1)[0];
    const typeLayout = JSON.parse(typeJson) as GhosttyTypeLayout;
    if (!typeLayout.GhosttyBuffer?.size) {
      throw new Error("libghostty-vt WASM did not describe GhosttyBuffer");
    }
    const terminalPointer = exports.ghostty_wasm_alloc_opaque();
    const terminalResult = exports.ghostty_terminal_new(
      0,
      terminalPointer,
      cols,
      rows,
    );
    const terminal = readHandle(exports, terminalPointer);
    exports.ghostty_wasm_free_opaque(terminalPointer);
    if (terminalResult !== SUCCESS || terminal === 0) {
      throw new Error(`ghostty_terminal_new failed with result ${terminalResult}`);
    }
    const foregroundPointer = exports.ghostty_wasm_alloc_u8_array(3);
    const backgroundPointer = exports.ghostty_wasm_alloc_u8_array(3);
    new Uint8Array(exports.memory.buffer, foregroundPointer, 3).set(DEFAULT_FOREGROUND);
    new Uint8Array(exports.memory.buffer, backgroundPointer, 3).set(DEFAULT_BACKGROUND);
    const foregroundResult = exports.ghostty_terminal_set(
      terminal,
      TERMINAL_OPTION_COLOR_FOREGROUND,
      foregroundPointer,
    );
    const backgroundResult = exports.ghostty_terminal_set(
      terminal,
      TERMINAL_OPTION_COLOR_BACKGROUND,
      backgroundPointer,
    );
    exports.ghostty_wasm_free_u8_array(foregroundPointer, 3);
    exports.ghostty_wasm_free_u8_array(backgroundPointer, 3);
    if (foregroundResult !== SUCCESS || backgroundResult !== SUCCESS) {
      exports.ghostty_terminal_free(terminal);
      throw new Error(
        `ghostty_terminal_set colors failed with results ${foregroundResult}/${backgroundResult}`,
      );
    }
    const statePointer = exports.ghostty_wasm_alloc_opaque();
    const stateResult = exports.ghostty_render_state_new(0, statePointer);
    const renderState = readHandle(exports, statePointer);
    exports.ghostty_wasm_free_opaque(statePointer);
    if (stateResult !== SUCCESS || renderState === 0) {
      exports.ghostty_terminal_free(terminal);
      throw new Error(`ghostty_render_state_new failed with result ${stateResult}`);
    }
    return new GhosttyVtCanvasRenderer(
      exports,
      typeLayout,
      terminal,
      renderState,
      cols,
      rows,
    );
  }

  /** Resize the real terminal parser and mark the next Canvas paint for redraw. */
  resize(cols: number, rows: number, cellWidth = 9, cellHeight = 18): void {
    const result = this.exports.ghostty_terminal_resize(
      this.terminal,
      cols,
      rows,
      cellWidth,
      cellHeight,
    );
    if (result !== SUCCESS) {
      throw new Error(`ghostty_terminal_resize failed with result ${result}`);
    }
    this.cols = cols;
    this.rowCount = rows;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.rows = Array.from({ length: rows }, (_, index) => this.rows[index] ?? "");
    this.forceRedraw = true;
  }

  /** Feed PTY bytes to libghostty-vt without converting through a text parser. */
  write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const pointer = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
    this.exports.ghostty_terminal_vt_write(this.terminal, pointer, bytes.length);
    this.exports.ghostty_wasm_free_u8_array(pointer, bytes.length);
  }

  /** Render only dirty rows from libghostty-vt's render-state iterator. */
  render(canvas: HTMLCanvasElement): GhosttyVtCanvasSnapshot {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.font = "13px ui-monospace, SFMono-Regular, Consolas, monospace";
    context.textBaseline = "alphabetic";
    const canvasMatchesGrid =
      canvas.width === this.cols * this.cellWidth &&
      canvas.height === this.rowCount * this.cellHeight;
    const updateResult = this.exports.ghostty_render_state_update(
      this.renderState,
      this.terminal,
    );
    if (updateResult !== SUCCESS) {
      throw new Error(`ghostty_render_state_update failed with result ${updateResult}`);
    }
    const dirtyResult = this.exports.ghostty_render_state_get(
      this.renderState,
      DATA_DIRTY,
      this.scratchPointer,
    );
    if (dirtyResult !== SUCCESS) {
      throw new Error(`ghostty_render_state_get(dirty) failed with result ${dirtyResult}`);
    }
    const dirtyState = readU32(this.exports, this.scratchPointer);
    const redrawAll = this.forceRedraw || dirtyState === 2;
    if (redrawAll) {
      context.fillStyle = "#10141d";
      context.fillRect(0, 0, this.cols * this.cellWidth, this.rowCount * this.cellHeight);
    }
    writeU32(this.exports, this.rowOutputPointer, this.rowIterator);
    const iteratorResult = this.exports.ghostty_render_state_get(
      this.renderState,
      DATA_ROW_ITERATOR,
      this.rowOutputPointer,
    );
    if (iteratorResult !== SUCCESS) {
      throw new Error(
        `ghostty_render_state_get(row iterator) failed with result ${iteratorResult}`,
      );
    }
    this.ensureRowCells();
    let rowIndex = 0;
    let dirtyRows = 0;
    let iteratedRows = 0;
    while (this.exports.ghostty_render_state_row_iterator_next(this.rowIterator)) {
      iteratedRows += 1;
      const rowDirty = this.exports.ghostty_render_state_row_get(
        this.rowIterator,
        ROW_DATA_DIRTY,
        this.scratchPointer,
      );
      if (rowDirty !== SUCCESS) {
        throw new Error(`ghostty_render_state_row_get(dirty) failed with result ${rowDirty}`);
      }
      const shouldDraw = redrawAll || readU32(this.exports, this.scratchPointer) !== 0;
      if (shouldDraw) {
        dirtyRows += 1;
        this.rows[rowIndex] = this.drawRow(context, rowIndex);
        writeU8(this.exports, this.scratchPointer, 0);
        const clearRow = this.exports.ghostty_render_state_row_set(
          this.rowIterator,
          ROW_OPTION_DIRTY,
          this.scratchPointer,
        );
        if (clearRow !== SUCCESS) {
          throw new Error(`ghostty_render_state_row_set failed with result ${clearRow}`);
        }
      }
      rowIndex += 1;
    }
    if (redrawAll && iteratedRows === 0) {
      for (const [index, row] of this.rows.entries()) {
        if (index >= this.rowCount || row.length === 0) continue;
        context.fillStyle = "#f1f5f9";
        context.fillText(row, 0, index * this.cellHeight + this.cellHeight - 4);
        dirtyRows += 1;
      }
    }
    writeU8(this.exports, this.scratchPointer, 0);
    const clearState = this.exports.ghostty_render_state_set(
      this.renderState,
      STATE_OPTION_DIRTY,
      this.scratchPointer,
    );
    if (clearState !== SUCCESS) {
      throw new Error(`ghostty_render_state_set failed with result ${clearState}`);
    }
    this.dirtyRows = dirtyRows;
    this.renderCount += 1;
    this.forceRedraw = !canvasMatchesGrid;
    return this.snapshot();
  }

  /** Return the latest text projection used for accessibility and comparison. */
  snapshot(): GhosttyVtCanvasSnapshot {
    return {
      dirtyRows: this.dirtyRows,
      renderCount: this.renderCount,
      text: this.rows.join("\n"),
    };
  }

  /** Release every libghostty-vt allocation owned by this renderer. */
  dispose(): void {
    this.exports.ghostty_wasm_free_u8_array(
      this.bufferDataPointer,
      this.bufferDataCapacity,
    );
    this.exports.ghostty_wasm_free_u8_array(
      this.bufferPointer,
      this.typeLayout.GhosttyBuffer.size,
    );
    this.exports.ghostty_wasm_free_u8_array(this.backgroundColorPointer, 3);
    this.exports.ghostty_wasm_free_u8_array(this.foregroundColorPointer, 3);
    this.exports.ghostty_wasm_free_opaque(this.cellsOutputPointer);
    this.exports.ghostty_wasm_free_opaque(this.rowOutputPointer);
    this.exports.ghostty_wasm_free_u8_array(this.scratchPointer, 4);
    if (this.rowCells !== null) {
      this.exports.ghostty_render_state_row_cells_free(this.rowCells);
    }
    this.exports.ghostty_render_state_row_iterator_free(this.rowIterator);
    this.exports.ghostty_render_state_free(this.renderState);
    this.exports.ghostty_terminal_free(this.terminal);
  }

  private setBuffer(): void {
    const view = new DataView(this.exports.memory.buffer);
    view.setUint32(this.bufferPointer, this.bufferDataPointer, true);
    view.setUint32(this.bufferPointer + 4, this.bufferDataCapacity, true);
    view.setUint32(this.bufferPointer + 8, 0, true);
  }

  private ensureRowCells(): void {
    if (this.rowCells !== null) return;
    const cellsPointer = this.exports.ghostty_wasm_alloc_opaque();
    const cellsResult = this.exports.ghostty_render_state_row_cells_new(
      0,
      cellsPointer,
    );
    this.rowCells = readHandle(this.exports, cellsPointer);
    this.exports.ghostty_wasm_free_opaque(cellsPointer);
    if (cellsResult !== SUCCESS || this.rowCells === 0) {
      throw new Error(
        `ghostty_render_state_row_cells_new failed with result ${cellsResult}`,
      );
    }
  }

  private readCellText(): string {
    if (this.rowCells === null) throw new Error("Ghostty row cells are not initialized");
    this.setBuffer();
    let result = this.exports.ghostty_render_state_row_cells_get(
      this.rowCells,
      CELL_DATA_GRAPHEMES_UTF8,
      this.bufferPointer,
    );
    if (result === OUT_OF_SPACE) {
      const required = readU32(this.exports, this.bufferPointer + 8);
      this.exports.ghostty_wasm_free_u8_array(
        this.bufferDataPointer,
        this.bufferDataCapacity,
      );
      this.bufferDataCapacity = Math.max(required, this.bufferDataCapacity * 2);
      this.bufferDataPointer = this.exports.ghostty_wasm_alloc_u8_array(
        this.bufferDataCapacity,
      );
      this.setBuffer();
      result = this.exports.ghostty_render_state_row_cells_get(
        this.rowCells,
        CELL_DATA_GRAPHEMES_UTF8,
        this.bufferPointer,
      );
    }
    if (result !== SUCCESS) {
      throw new Error(`ghostty_render_state_row_cells_get(text) failed with result ${result}`);
    }
    const length = readU32(this.exports, this.bufferPointer + 8);
    return new TextDecoder().decode(
      new Uint8Array(this.exports.memory.buffer, this.bufferDataPointer, length),
    );
  }

  private drawRow(context: CanvasRenderingContext2D, rowIndex: number): string {
    if (this.rowCells === null) throw new Error("Ghostty row cells are not initialized");
    writeU32(this.exports, this.cellsOutputPointer, this.rowCells);
    const rowResult = this.exports.ghostty_render_state_row_get(
      this.rowIterator,
      ROW_DATA_CELLS,
      this.cellsOutputPointer,
    );
    if (rowResult !== SUCCESS) {
      throw new Error(`ghostty_render_state_row_get(cells) failed with result ${rowResult}`);
    }
    const rowText: string[] = [];
    let column = 0;
    while (this.exports.ghostty_render_state_row_cells_next(this.rowCells)) {
      const backgroundResult = this.exports.ghostty_render_state_row_cells_get(
        this.rowCells,
        CELL_DATA_BG_COLOR,
        this.backgroundColorPointer,
      );
      const foregroundResult = this.exports.ghostty_render_state_row_cells_get(
        this.rowCells,
        CELL_DATA_FG_COLOR,
        this.foregroundColorPointer,
      );
      const text = this.readCellText();
      rowText.push(text);
      const x = column * this.cellWidth;
      const y = rowIndex * this.cellHeight;
      if (backgroundResult === SUCCESS) {
        context.fillStyle = readColor(this.exports, this.backgroundColorPointer);
        context.fillRect(x, y, this.cellWidth, this.cellHeight);
      }
      if (text.length > 0) {
        context.fillStyle = foregroundResult === SUCCESS ? readColor(this.exports, this.foregroundColorPointer) : "#f1f5f9";
        context.fillText(text, x, y + this.cellHeight - 4);
      }
      column += 1;
    }
    return rowText.join("");
  }
}
