import {createHash} from "node:crypto";

/** Small in-memory LRU: an unchanged file reviewed twice with the same model and settings is answered instantly. */
export class ResultCache<T> {
  private readonly entries = new Map<string, T>();
  constructor(private readonly limit = 30) {}
  static key(...parts: unknown[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }
  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as string);
  }
}
