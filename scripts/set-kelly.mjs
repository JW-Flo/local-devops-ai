// Quick script to set Kelly fraction via the market agent API
const fraction = Number(process.argv[2] || 0.50);
const res = await fetch('http://localhost:4125/market/kelly', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fraction }),
});
const data = await res.json();
console.log('Kelly response:', JSON.stringify(data, null, 2));

// Also fetch status to verify
const status = await fetch('http://localhost:4125/market/status');
const s = await status.json();
console.log('Kelly fraction in status:', s.kellyFraction);
console.log('Edge threshold:', s.edgeThreshold);
console.log('Signals:', s.signals, '| YES-buy:', s.signalBreakdown?.yesBuy, '| NO-buy:', s.signalBreakdown?.noBuy);
