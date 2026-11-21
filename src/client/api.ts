export class CodizApiClient {
  private token: string | null = null;

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type') && init.body) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const res = await fetch(path, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data as { error?: string }).error || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data as T;
  }
}

export const apiClient = new CodizApiClient();

export function formatCurrency(
  usdAmount: number,
  currencyCode: string,
  rates: Record<string, { symbol: string; perUsd: number }>
): string {
  const rate = rates[currencyCode] ?? { symbol: '$', perUsd: 1 };
  const val = usdAmount * rate.perUsd;
  if (currencyCode === 'USD') return `${rate.symbol}${val.toFixed(2)}`;
  if (val < 10) return `${rate.symbol} ${val.toFixed(2)}`;
  return `${rate.symbol} ${Math.round(val).toLocaleString()}`;
}
