export interface StationControl {
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface DerivedLineage {
  ear: string;
}
export interface DerivedIssuer {
  issue(
    lineage: DerivedLineage,
    text: string,
  ): Promise<{ capsule: Uint8Array; electionId: string }>;
}
export interface DerivedRoute {
  control: StationControl;
  issuer: DerivedIssuer;
}
export function unixStationControl(path: string): StationControl {
  throw new Error(`not implemented: ${path}`);
}
