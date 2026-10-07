/**
 * Weaver core type model.
 *
 * A Node is a module/component/symbol discovered in a codebase.
 * An Edge is a resolved relationship (import, call, dependency).
 * Nodes + edges form a directed graph that the analyzer applies graph
 * algorithms to (cycles, SCC, hot paths, depth).
 *
 * Node IDs are deterministic (root-relative path, optionally "#name")
 * so multiple analysis runs are comparable and shareable.
 */

export type NodeKind =
  | 'module'
  | 'component'
  | 'function'
  | 'variable'
  | 'library';

export type EdgeType = 'import' | 'call' | 'dependency' | 'dynamic';

export type Severity = 'error' | 'warning' | 'info';

export type LogFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
) => void;

/** A reference from the analyzed code to something it depends on. */
export interface DependencyReference {
  /** specifier exactly as written in the source */
  specifier: string;
  /** true for require()/import() with computed specifiers */
  dynamic: boolean;
  /** imported member name when known */
  binding: string | null;
  location: SourceLocation;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface NodeMeta {
  scope?: string;
  [key: string]: unknown;
}

export interface WeaverNode {
  id: string;
  type: NodeKind;
  label: string;
  location: SourceLocation;
  metadata: NodeMeta;
  /** byte size of the backing source file (0 for symbols) */
  size: number;
  /** number of source lines in the symbol, or the whole file */
  lineCount: number;
  incomingEdgeCount: number;
  outgoingEdgeCount: number;
}

export interface WeaverEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  /** usage frequency / call count */
  weight: number;
  dynamic: boolean;
  locations: SourceLocation[];
}

export interface Cycle {
  path: string[];
  length: number;
  severity: Severity;
}

export type InsightType =
  | 'cycle'
  | 'bottleneck'
  | 'hot-path'
  | 'deep-chain'
  | 'warning';

export interface Insight {
  type: InsightType;
  severity: Severity;
  nodes: string[];
  message: string;
  details: Record<string, unknown>;
}

export interface Graph {
  nodes: WeaverNode[];
  edges: WeaverEdge[];
  project: string;
  generatedAt: string;
}

export interface AnalyzeResult {
  runId: string;
  project: string;
  rootDir: string;
  durationMs: number;
  graph: Graph;
  insights: Insight[];
  cycles: Cycle[];
  summary: {
    fileCount: number;
    parseErrors: number;
    unresolved: number;
    dynamic: number;
    external: number;
    nodeCount: number;
    edgeCount: number;
    lineCount: number;
    locCount: number;
  };
}
