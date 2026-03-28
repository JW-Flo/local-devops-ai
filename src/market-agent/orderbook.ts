import { OrderbookLevel, MarketOrderbook } from './types.js';

export class OrderbookState {
  private books: Map<string, MarketOrderbook> = new Map();

  applyDelta(delta: {
    market_ticker: string;
    yes: Array<[number, number]>;
    no: Array<[number, number]>;
  }): void {
    const ticker = delta.market_ticker;
    let book = this.books.get(ticker);
    if (!book) {
      book = { ticker, yesBids: [], yesAsks: [], lastUpdateMs: Date.now() };
      this.books.set(ticker, book);
    }

    if (delta.yes) {
      for (const [priceCents, size] of delta.yes) {
        const price = priceCents / 100;
        this.updateLevel(book.yesBids, price, size);
      }
      book.yesBids.sort((a, b) => b.price - a.price);
    }

    if (delta.no) {
      for (const [priceCents, size] of delta.no) {
        const yesPrice = (100 - priceCents) / 100;
        this.updateLevel(book.yesAsks, yesPrice, size);
      }
      book.yesAsks.sort((a, b) => a.price - b.price);
    }

    book.lastUpdateMs = Date.now();
  }

  applySnapshot(ticker: string, data: {
    yes: Array<{ price: number; quantity: number }>;
    no: Array<{ price: number; quantity: number }>;
  }): void {
    const yesBids: OrderbookLevel[] = data.yes.map((l) => ({
      price: l.price,
      size: l.quantity,
    }));
    yesBids.sort((a, b) => b.price - a.price);

    const yesAsks: OrderbookLevel[] = data.no.map((l) => ({
      price: 1 - l.price,
      size: l.quantity,
    }));
    yesAsks.sort((a, b) => a.price - b.price);

    this.books.set(ticker, {
      ticker,
      yesBids,
      yesAsks,
      lastUpdateMs: Date.now(),
    });
  }

  private updateLevel(levels: OrderbookLevel[], price: number, size: number): void {
    const idx = levels.findIndex((l) => Math.abs(l.price - price) < 0.001);
    if (size === 0) {
      if (idx >= 0) levels.splice(idx, 1);
    } else if (idx >= 0) {
      levels[idx].size = size;
    } else {
      levels.push({ price, size });
    }
  }

  getBook(ticker: string): MarketOrderbook | undefined {
    return this.books.get(ticker);
  }

  getBestBid(ticker: string): number | undefined {
    const book = this.books.get(ticker);
    return book?.yesBids[0]?.price;
  }

  getBestAsk(ticker: string): number | undefined {
    const book = this.books.get(ticker);
    return book?.yesAsks[0]?.price;
  }

  getAllTickers(): string[] {
    return Array.from(this.books.keys());
  }

  getStaleBooks(maxAgeMs: number): string[] {
    const now = Date.now();
    return Array.from(this.books.entries())
      .filter(([_, book]) => now - book.lastUpdateMs > maxAgeMs)
      .map(([ticker]) => ticker);
  }

  toSnapshot(): Record<string, { bestBid: number | undefined; bestAsk: number | undefined }> {
    const result: Record<string, { bestBid: number | undefined; bestAsk: number | undefined }> = {};
    for (const [ticker, book] of this.books) {
      result[ticker] = {
        bestBid: book.yesBids[0]?.price,
        bestAsk: book.yesAsks[0]?.price,
      };
    }
    return result;
  }
}