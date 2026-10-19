/**
 * Text of a message's components (#78). A message sent with Components V2 (flag
 * `IS_COMPONENTS_V2`) has an empty `content`: its text lives in TextDisplay components,
 * nested in Sections and Containers. Buttons and selects carry labels too, and legacy
 * messages can carry an ActionRow of them beside their `content`.
 *
 * Component text is author-controlled exactly like `content`. It is joined with `content`
 * at ingest and stored as the event's content, so it gets the same quoting, tag neutralising
 * and control stripping at render time, the same `maxMessageChars` cap, and never sets
 * trust. Recursion depth and the number of components read are bounded here, before the
 * character cap, so a hostile payload costs little.
 */

/** Discord message flag: the message's text is in its components, not `content`. */
export const IS_COMPONENTS_V2 = 1 << 15;

/** Deepest nesting read. Discord allows container → section → text (3); 6 leaves room. */
export const MAX_COMPONENT_DEPTH = 6;
/** Most components read from one message. Discord caps a message at 40 top-level ones. */
export const MAX_COMPONENTS = 200;

// Discord component types (https://discord.com/developers/docs/components/reference).
const ACTION_ROW = 1;
const BUTTON = 2;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const MEDIA_GALLERY = 12;
const FILE = 13;
const CONTAINER = 17;
const SELECTS = new Set([3, 5, 6, 7, 8]);

type Component = Record<string, unknown>;

function asComponent(value: unknown): Component | null {
  return value && typeof value === "object" ? (value as Component) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

class Reader {
  private readonly lines: string[] = [];
  private budget = MAX_COMPONENTS;

  /** `prose`: the author's text blocks only, no control labels or media markers. */
  private readonly prose: boolean;

  public constructor(prose = false) {
    this.prose = prose;
  }

  public text(): string {
    return this.lines.join("\n");
  }

  public list(value: unknown, depth: number): void {
    if (!Array.isArray(value) || depth > MAX_COMPONENT_DEPTH) {
      return;
    }
    for (const item of value) {
      if (this.budget <= 0) {
        return;
      }
      this.one(item, depth);
    }
  }

  private one(value: unknown, depth: number): void {
    const component = asComponent(value);
    if (!component || typeof component.type !== "number") {
      return;
    }
    this.budget -= 1;
    switch (component.type) {
      case TEXT_DISPLAY:
        this.push(str(component.content));
        return;
      case CONTAINER:
        this.list(component.components, depth + 1);
        return;
      case SECTION:
        this.list(component.components, depth + 1);
        this.push(this.control(asComponent(component.accessory)));
        return;
      case ACTION_ROW: {
        if (this.prose) {
          return;
        }
        // One line per row: its buttons and selects, each marked as a control.
        const controls: string[] = [];
        if (
          Array.isArray(component.components) &&
          depth < MAX_COMPONENT_DEPTH
        ) {
          for (const item of component.components) {
            if (this.budget <= 0) {
              break;
            }
            const control = asComponent(item);
            if (control && typeof control.type === "number") {
              this.budget -= 1;
              const label = this.control(control);
              if (label) {
                controls.push(label);
              }
            }
          }
        }
        this.push(controls.length > 0 ? controls.join(" ") : null);
        return;
      }
      case MEDIA_GALLERY: {
        if (this.prose) {
          return;
        }
        const items = Array.isArray(component.items) ? component.items : [];
        for (const _item of items.slice(0, this.budget)) {
          this.budget -= 1;
          this.push("[image]");
        }
        return;
      }
      default:
        this.push(this.control(component));
    }
  }

  /** A control or media leaf, marked so it never reads as the author's prose. */
  private control(component: Component | null): string | null {
    if (!component || this.prose) {
      return null;
    }
    if (component.type === BUTTON) {
      const label = str(component.label);
      return label ? `[button: ${label}]` : "[button]";
    }
    if (typeof component.type === "number" && SELECTS.has(component.type)) {
      const placeholder = str(component.placeholder);
      return placeholder ? `[select: ${placeholder}]` : "[select]";
    }
    if (component.type === THUMBNAIL) {
      return "[image]";
    }
    if (component.type === FILE) {
      return "[file]";
    }
    // Separators, labels, text inputs and anything newer: nothing to read.
    return null;
  }

  private push(line: string | null): void {
    if (line) {
      this.lines.push(line);
    }
  }
}

/** The readable text of a message's `components`, one line per text block; "" when none. */
export function componentText(components: unknown): string {
  const reader = new Reader();
  reader.list(components, 1);
  return reader.text();
}

/**
 * The author's prose in a message's components: TextDisplay blocks only, without button or
 * select labels or media markers. Attention matching reads this, so a V2 message that names
 * the ear wakes it like `content` would, while a control label never counts as addressing.
 */
export function componentProse(components: unknown): string {
  const reader = new Reader(true);
  reader.list(components, 1);
  return reader.text();
}

/** `content` and the components' text, joined, capped at `maxChars`. */
export function messageText(
  message: { content: string; components?: unknown },
  maxChars: number,
): string {
  const parts = [message.content, componentText(message.components)].filter(
    (part) => part.length > 0,
  );
  return parts.join("\n").slice(0, maxChars);
}
