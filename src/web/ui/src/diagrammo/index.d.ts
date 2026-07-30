export interface DiagrammoStatePalette {
  readonly border: string;
  readonly fill: string;
  readonly dot: string;
  readonly dash?: string;
}

export interface DiagrammoTheme {
  readonly name: string;
  readonly bg: string;
  readonly band: string;
  readonly ink: string;
  readonly muted: string;
  readonly laneLabel: string;
  readonly hair: string;
  readonly pillFill: string;
  readonly pillStroke: string;
  readonly shadowOpacity: number;
  readonly state: {
    readonly healthy: DiagrammoStatePalette;
    readonly degraded: DiagrammoStatePalette;
    readonly unhealthy: DiagrammoStatePalette;
    readonly unknown: DiagrammoStatePalette;
    readonly alt: DiagrammoStatePalette;
    readonly signal: DiagrammoStatePalette;
  };
  readonly metricBars: readonly string[];
}

export interface SwimlaneBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SwimlaneCard {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly headerH: number;
  readonly qualLines: number;
  readonly lane: number;
}

export interface SwimlaneLane {
  readonly top: number;
  readonly h: number;
  readonly label: string;
}

export interface SwimlaneStatusPill {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly id: string;
  readonly container: SwimlaneBox;
}

export interface SwimlaneDebug {
  readonly cards: readonly SwimlaneCard[];
  readonly lanes: readonly SwimlaneLane[];
  readonly statusPills: readonly SwimlaneStatusPill[];
}

export interface SwimlaneResult {
  readonly svg: string;
  readonly W: number;
  readonly H: number;
  readonly nodes: number;
  readonly lanes: number;
  readonly debug: SwimlaneDebug;
  readonly diag: unknown;
}

export interface RenderSwimlaneOptions {
  readonly theme?: string | DiagrammoTheme;
  readonly title?: string;
  readonly subtitle?: string;
  readonly maxWidth?: number;
  readonly laneLabels?: boolean;
  readonly legend?: boolean;
  readonly lanes?: readonly string[];
}

export function renderSwimlane(
  code: string,
  opts?: RenderSwimlaneOptions,
): SwimlaneResult;

export function getTheme(name: string): DiagrammoTheme;

export declare const THEMES: Readonly<Record<string, DiagrammoTheme>>;
export declare const THEME_NAMES: readonly string[];
