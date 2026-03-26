// ── Chart theme ──────────────────────────────────────────────
const CHART_COLORS = {
  primary:  '#3b82f6',
  success:  '#10b981',
  warning:  '#f59e0b',
  danger:   '#ef4444',
  palette:  ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#0ea5e9','#f97316'],
};

// Mapea nombres de estado a colores consistentes
const STATUS_COLORS = {
  'En proceso': '#3b82f6',
  'Pendiente':  '#f59e0b',
  'Completada': '#10b981',
  'Observada':  '#8b5cf6',
  'Cancelada':  '#ef4444',
  'Suspendida': '#94a3b8',
};

Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size   = 12;
Chart.defaults.color       = '#64748b';

function renderChart(id, type = 'bar') {
  const el = document.getElementById(id);
  if (!el) return;

  const labels  = JSON.parse(el.dataset.labels || '[]');
  const values  = JSON.parse(el.dataset.values  || '[]');
  const ctx     = el.getContext('2d');
  const isDonut = type === 'doughnut' || type === 'pie';
  const isLine  = type === 'line';

  const dataset = {
    data: values,
    tension: 0.42,
    borderWidth: isDonut ? 2 : 0,
  };

  if (isDonut) {
    dataset.backgroundColor = labels.map(
      (l, i) => STATUS_COLORS[l] || CHART_COLORS.palette[i % CHART_COLORS.palette.length]
    );
    dataset.borderColor  = '#ffffff';
    dataset.hoverOffset  = 10;
    dataset.borderRadius = 4;
  } else if (isLine) {
    // Gradiente suave bajo la curva
    const grad = ctx.createLinearGradient(0, 0, 0, 280);
    grad.addColorStop(0,   'rgba(59,130,246,.18)');
    grad.addColorStop(0.65,'rgba(59,130,246,.05)');
    grad.addColorStop(1,   'rgba(59,130,246,0)');
    dataset.fill                 = true;
    dataset.backgroundColor      = grad;
    dataset.borderColor          = '#3b82f6';
    dataset.borderWidth          = 2.5;
    dataset.pointBackgroundColor = '#3b82f6';
    dataset.pointBorderColor     = '#ffffff';
    dataset.pointBorderWidth     = 2;
    dataset.pointRadius          = 5;
    dataset.pointHoverRadius     = 7;
  } else {
    dataset.backgroundColor = labels.map(
      (_, i) => CHART_COLORS.palette[i % CHART_COLORS.palette.length]
    );
    dataset.borderRadius  = 7;
    dataset.borderSkipped = false;
  }

  new Chart(el, {
    type,
    data: { labels, datasets: [{ label: '', ...dataset }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: isDonut,
          position: 'bottom',
          labels: {
            padding: 18,
            usePointStyle: true,
            pointStyle: 'circle',
            pointStyleWidth: 9,
            font: { size: 12, weight: '500' },
            color: '#475569',
          },
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#f1f5f9',
          bodyColor: 'rgba(241,245,249,.82)',
          padding: { x: 14, y: 10 },
          cornerRadius: 10,
          boxPadding: 5,
          borderColor: 'rgba(255,255,255,.1)',
          borderWidth: 1,
          callbacks: {
            label: function(c) {
              const val   = isDonut ? c.parsed : (c.parsed?.y ?? c.parsed);
              const total = isDonut
                ? c.chart.data.datasets[0].data.reduce((a, b) => a + b, 0)
                : null;
              const pct = total > 0 ? ` (${Math.round(val / total * 100)}%)` : '';
              return `  ${c.label || c.dataset.label}: ${val}${pct}`;
            },
          },
        },
      },
      scales: isDonut ? {} : {
        x: {
          grid:   { display: false },
          border: { display: false },
          ticks:  { font: { size: 11 }, color: '#94a3b8', maxRotation: 0 },
        },
        y: {
          beginAtZero: true,
          grid:   { color: 'rgba(15,23,42,.04)', drawBorder: false },
          border: { display: false, dash: [4, 4] },
          ticks:  { font: { size: 11 }, color: '#94a3b8', precision: 0 },
        },
      },
    },
  });
}

window.addEventListener('DOMContentLoaded', () => {
  renderChart('cumplidasChart', 'line');
  renderChart('estadoChart', 'doughnut');
  renderChart('avanceProyectoChart', 'bar');
  renderChart('costosCategoriaChart', 'bar');
});

