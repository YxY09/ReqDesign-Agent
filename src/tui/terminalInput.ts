type Token =
  | { type: "text"; value: string }
  | { type: "sequence"; value: string };

type TokenizerState =
  | "ground"
  | "escape"
  | "escapeIntermediate"
  | "csi"
  | "ss3"
  | "osc"
  | "dcs"
  | "apc";

interface Tokenizer {
  feed(input: string): Token[];
  flush(): Token[];
  buffer(): string;
}

interface KeyParseState {
  mode: "NORMAL" | "IN_PASTE";
  pasteBuffer: string;
  incomplete: string;
  tokenizer: Tokenizer;
}

export interface InputKey {
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
  raw: string;
}

export type TerminalInputEvent =
  | { kind: "key"; key: InputKey; text?: string }
  | { kind: "mouse"; sequence: string; button: number; action: "press" | "release"; col: number; row: number };

export interface TerminalInputState {
  mode: "NORMAL" | "IN_PASTE";
  incomplete: string;
  pasteBuffer: string;
  _parser: KeyParseState;
}

const ESC = "\u001b";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/;
const FN_KEY_RE =
  /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u/;
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/;
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

const C0 = {
  BEL: 0x07,
  ESC: 0x1b,
};

const ESC_TYPE = {
  CSI: 0x5b,
  OSC: 0x5d,
  DCS: 0x50,
  APC: 0x5f,
  ST: 0x5c,
};

function isEscFinal(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x7e;
}

function isCSIParam(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x3f;
}

function isCSIIntermediate(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x2f;
}

function isCSIFinal(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e;
}

const keyName: Record<string, string> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[F": "end",
  "[H": "home",
  "OA": "up",
  "OB": "down",
  "OC": "right",
  "OD": "left",
  "OF": "end",
  "OH": "home",
  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  "[Z": "tab",
};

function decodeModifier(modifier: number): { shift: boolean; meta: boolean; ctrl: boolean } {
  const value = modifier - 1;
  return {
    shift: !!(value & 1),
    meta: !!(value & 2),
    ctrl: !!(value & 4),
  };
}

function keycodeToName(keycode: number): string | undefined {
  switch (keycode) {
    case 9:
      return "tab";
    case 13:
      return "return";
    case 27:
      return "escape";
    case 32:
      return "space";
    case 127:
      return "backspace";
    default:
      if (keycode >= 32 && keycode <= 126) {
        return String.fromCharCode(keycode).toLowerCase();
      }
      return undefined;
  }
}

function createTokenizer(x10Mouse = true): Tokenizer {
  let currentState: TokenizerState = "ground";
  let currentBuffer = "";

  const tokenize = (input: string, flush: boolean): Token[] => {
    const tokens: Token[] = [];
    const data = currentBuffer + input;
    let buffer = "";
    let state = currentState;
    let i = 0;
    let textStart = 0;
    let seqStart = 0;

    const flushText = () => {
      if (i > textStart) {
        const text = data.slice(textStart, i);
        if (text) tokens.push({ type: "text", value: text });
      }
      textStart = i;
    };

    const emitSequence = (seq: string) => {
      if (seq) tokens.push({ type: "sequence", value: seq });
      state = "ground";
      textStart = i;
    };

    while (i < data.length) {
      const code = data.charCodeAt(i);
      switch (state) {
        case "ground":
          if (code === C0.ESC) {
            flushText();
            seqStart = i;
            state = "escape";
            i += 1;
          } else {
            i += 1;
          }
          break;
        case "escape":
          if (code === ESC_TYPE.CSI) {
            state = "csi";
            i += 1;
          } else if (code === ESC_TYPE.OSC) {
            state = "osc";
            i += 1;
          } else if (code === ESC_TYPE.DCS) {
            state = "dcs";
            i += 1;
          } else if (code === ESC_TYPE.APC) {
            state = "apc";
            i += 1;
          } else if (code === 0x4f) {
            state = "ss3";
            i += 1;
          } else if (isCSIIntermediate(code)) {
            state = "escapeIntermediate";
            i += 1;
          } else if (isEscFinal(code)) {
            i += 1;
            emitSequence(data.slice(seqStart, i));
          } else if (code === C0.ESC) {
            emitSequence(data.slice(seqStart, i));
            seqStart = i;
            state = "escape";
            i += 1;
          } else {
            state = "ground";
            textStart = seqStart;
          }
          break;
        case "escapeIntermediate":
          if (isCSIIntermediate(code)) {
            i += 1;
          } else if (isEscFinal(code)) {
            i += 1;
            emitSequence(data.slice(seqStart, i));
          } else {
            state = "ground";
            textStart = seqStart;
          }
          break;
        case "csi":
          if (
            x10Mouse &&
            code === 0x4d &&
            i - seqStart === 2 &&
            (i + 1 >= data.length || data.charCodeAt(i + 1) >= 0x20) &&
            (i + 2 >= data.length || data.charCodeAt(i + 2) >= 0x20) &&
            (i + 3 >= data.length || data.charCodeAt(i + 3) >= 0x20)
          ) {
            if (i + 4 <= data.length) {
              i += 4;
              emitSequence(data.slice(seqStart, i));
            } else {
              i = data.length;
            }
            break;
          }
          if (isCSIFinal(code)) {
            i += 1;
            emitSequence(data.slice(seqStart, i));
          } else if (isCSIParam(code) || isCSIIntermediate(code)) {
            i += 1;
          } else {
            state = "ground";
            textStart = seqStart;
          }
          break;
        case "ss3":
          if (code >= 0x40 && code <= 0x7e) {
            i += 1;
            emitSequence(data.slice(seqStart, i));
          } else {
            state = "ground";
            textStart = seqStart;
          }
          break;
        case "osc":
        case "dcs":
        case "apc":
          if (code === C0.BEL) {
            i += 1;
            emitSequence(data.slice(seqStart, i));
          } else if (
            code === C0.ESC &&
            i + 1 < data.length &&
            data.charCodeAt(i + 1) === ESC_TYPE.ST
          ) {
            i += 2;
            emitSequence(data.slice(seqStart, i));
          } else {
            i += 1;
          }
          break;
      }
    }

    if (state === "ground") {
      flushText();
      buffer = "";
    } else if (flush) {
      const remaining = data.slice(seqStart);
      if (remaining) tokens.push({ type: "sequence", value: remaining });
      state = "ground";
      buffer = "";
    } else {
      buffer = data.slice(seqStart);
    }

    currentState = state;
    currentBuffer = buffer;
    return tokens;
  };

  return {
    feed(input: string): Token[] {
      return tokenize(input, false);
    },
    flush(): Token[] {
      return tokenize("", true);
    },
    buffer(): string {
      return currentBuffer;
    },
  };
}

function createKey(sequence: string, name?: string, ctrl = false, meta = false, shift = false): InputKey {
  return {
    name,
    ctrl,
    meta,
    shift,
    sequence,
    raw: sequence,
  };
}

function createTextEvent(text: string): TerminalInputEvent {
  return {
    kind: "key",
    key: createKey(text),
    text,
  };
}

function isControlCharacter(char: string): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

function appendTextEvents(events: TerminalInputEvent[], text: string): void {
  if (!text) return;

  let plainBuffer = "";
  const flushPlainBuffer = () => {
    if (!plainBuffer) return;
    events.push(createTextEvent(plainBuffer));
    plainBuffer = "";
  };

  for (const char of Array.from(text)) {
    if (isControlCharacter(char)) {
      flushPlainBuffer();
      events.push(parseSequenceToKey(char));
      continue;
    }
    plainBuffer += char;
  }

  flushPlainBuffer();
}

function parseMouseEvent(sequence: string): TerminalInputEvent | null {
  const sgr = SGR_MOUSE_RE.exec(sequence);
  if (sgr) {
    const button = Number.parseInt(sgr[1] ?? "", 10);
    if ((button & 0x43) === 0x40) {
      return { kind: "key", key: createKey(sequence, "wheelup") };
    }
    if ((button & 0x43) === 0x41) {
      return { kind: "key", key: createKey(sequence, "wheeldown") };
    }
    return {
      kind: "mouse",
      button,
      action: sgr[4] === "M" ? "press" : "release",
      col: Number.parseInt(sgr[2] ?? "0", 10),
      row: Number.parseInt(sgr[3] ?? "0", 10),
      sequence,
    };
  }

  if (sequence.length === 6 && sequence.startsWith("\u001b[M")) {
    const button = sequence.charCodeAt(3) - 32;
    if ((button & 0x43) === 0x40) {
      return { kind: "key", key: createKey(sequence, "wheelup") };
    }
    if ((button & 0x43) === 0x41) {
      return { kind: "key", key: createKey(sequence, "wheeldown") };
    }
    return {
      kind: "mouse",
      button,
      action: "press",
      col: sequence.charCodeAt(4) - 32,
      row: sequence.charCodeAt(5) - 32,
      sequence,
    };
  }

  return null;
}

function parseSequenceToKey(sequence: string): TerminalInputEvent {
  let match: RegExpExecArray | null;

  if ((match = CSI_U_RE.exec(sequence))) {
    const codepoint = Number.parseInt(match[1] ?? "", 10);
    const modifier = match[2] ? Number.parseInt(match[2], 10) : 1;
    const mods = decodeModifier(modifier);
    return {
      kind: "key",
      key: createKey(sequence, keycodeToName(codepoint), mods.ctrl, mods.meta, mods.shift),
    };
  }

  if ((match = MODIFY_OTHER_KEYS_RE.exec(sequence))) {
    const mods = decodeModifier(Number.parseInt(match[1] ?? "", 10));
    return {
      kind: "key",
      key: createKey(sequence, keycodeToName(Number.parseInt(match[2] ?? "", 10)), mods.ctrl, mods.meta, mods.shift),
    };
  }

  const mouse = parseMouseEvent(sequence);
  if (mouse) return mouse;

  if (sequence === "\r") return { kind: "key", key: createKey(sequence, "return") };
  if (sequence === "\n") return { kind: "key", key: createKey(sequence, "j", true) };
  if (sequence === "\t") return { kind: "key", key: createKey(sequence, "tab") };
  if (sequence === "\b" || sequence === "\x7f") return { kind: "key", key: createKey(sequence, "backspace") };
  if (sequence === "\x1b") return { kind: "key", key: createKey(sequence, "escape") };
  if (sequence === "\x03") return { kind: "key", key: createKey(sequence, "c", true) };
  if (sequence === "\x0c") return { kind: "key", key: createKey(sequence, "l", true) };
  if (sequence === "\x0a") return { kind: "key", key: createKey(sequence, "j", true) };
  if (sequence === "\x12") return { kind: "key", key: createKey(sequence, "r", true) };

  if ((match = META_KEY_CODE_RE.exec(sequence))) {
    const letter = match[1] ?? "";
    return {
      kind: "key",
      key: createKey(sequence, letter.toLowerCase(), false, true, letter >= "A" && letter <= "Z"),
    };
  }

  if ((match = FN_KEY_RE.exec(sequence))) {
    const code = [match[1], match[2], match[4], match[6]].filter(Boolean).join("");
    const modifier = Number((match[3] || match[5] || 1)) - 1;
    const key = createKey(sequence, keyName[code], !!(modifier & 4), !!(modifier & 2), !!(modifier & 1));
    return { kind: "key", key };
  }

  if (sequence === "\u001b[1~") return { kind: "key", key: createKey(sequence, "home") };
  if (sequence === "\u001b[4~") return { kind: "key", key: createKey(sequence, "end") };
  if (sequence === "\u001b[5~") return { kind: "key", key: createKey(sequence, "pageup") };
  if (sequence === "\u001b[6~") return { kind: "key", key: createKey(sequence, "pagedown") };

  return createTextEvent(sequence);
}

export function createInitialTerminalInputState(): TerminalInputState {
  const tokenizer = createTokenizer(true);
  return {
    mode: "NORMAL",
    incomplete: "",
    pasteBuffer: "",
    _parser: {
      mode: "NORMAL",
      pasteBuffer: "",
      incomplete: "",
      tokenizer,
    },
  };
}

function inputToString(input: string | Buffer | null): string {
  if (input === null) return "";
  if (typeof input === "string") return input;
  return String(input);
}

export function parseTerminalInput(
  prevState: TerminalInputState,
  input: string | Buffer | null,
): [TerminalInputEvent[], TerminalInputState] {
  const isFlush = input === null;
  const parserState = prevState._parser;
  const normalized = inputToString(input);
  const tokens = isFlush ? parserState.tokenizer.flush() : parserState.tokenizer.feed(normalized);

  const events: TerminalInputEvent[] = [];
  let inPaste = parserState.mode === "IN_PASTE";
  let pasteBuffer = parserState.pasteBuffer;

  for (const token of tokens) {
    if (token.type === "sequence") {
      if (token.value === PASTE_START) {
        inPaste = true;
        pasteBuffer = "";
        continue;
      }
      if (token.value === PASTE_END) {
        appendTextEvents(events, pasteBuffer);
        inPaste = false;
        pasteBuffer = "";
        continue;
      }
      if (inPaste) {
        pasteBuffer += token.value;
        continue;
      }
      events.push(parseSequenceToKey(token.value));
      continue;
    }

    if (inPaste) {
      pasteBuffer += token.value;
      continue;
    }

    if (/^\[<\d+;\d+;\d+[Mm]$/.test(token.value) || /^\[M[\u0060-\u007f][\s\S]{2}$/.test(token.value)) {
      events.push(parseSequenceToKey(`${ESC}${token.value}`));
      continue;
    }

    appendTextEvents(events, token.value);
  }

  if (isFlush && inPaste && pasteBuffer) {
    appendTextEvents(events, pasteBuffer);
    inPaste = false;
    pasteBuffer = "";
  }

  const nextState: TerminalInputState = {
    mode: inPaste ? "IN_PASTE" : "NORMAL",
    incomplete: parserState.tokenizer.buffer(),
    pasteBuffer,
    _parser: {
      mode: inPaste ? "IN_PASTE" : "NORMAL",
      pasteBuffer,
      incomplete: parserState.tokenizer.buffer(),
      tokenizer: parserState.tokenizer,
    },
  };

  return [events, nextState];
}
