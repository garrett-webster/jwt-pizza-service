const config = require('./config').metrics;
const os = require('os');

// Metrics stored in memory
const requests = {};
let latencyTotalMs = 0;
let latencyCount = 0;
const authAttempts = { success: 0, failure: 0 };
const pizzas = { sold: 0, failures: 0, revenue: 0, latencyTotalMs: 0, latencyCount: 0 };
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const activeUsers = new Map(); // userId -> last seen (ms)

// Middleware to track requests
function requestTracker(req, res, next) {
  const start = Date.now();
  requests[req.method] = (requests[req.method] || 0) + 1;
  if (req.user) activeUsers.set(req.user.id, start);
  res.on('finish', () => {
    latencyTotalMs += Date.now() - start;
    latencyCount++;
    if (req.method === 'PUT' && req.originalUrl.split('?')[0] === '/api/auth') {
      authAttempts[res.statusCode < 400 ? 'success' : 'failure']++;
    }
  });
  next();
}

// Called by the order router after the factory responds
function pizzaPurchase(success, latencyMs, pizzaCount, revenue) {
  if (success) {
    pizzas.sold += pizzaCount;
    pizzas.revenue += revenue;
  } else {
    pizzas.failures++;
  }
  pizzas.latencyTotalMs += latencyMs;
  pizzas.latencyCount++;
}

// This will periodically send metrics to Grafana
setInterval(() => {
  const metrics = [];
  Object.keys(requests).forEach((method) => {
    metrics.push(createMetric('requests', requests[method], '1', 'sum', 'asInt', { method }));
  });

  Object.keys(authAttempts).forEach((result) => {
    metrics.push(createMetric('authAttempts', authAttempts[result], '1', 'sum', 'asInt', { result }));
  });

  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  activeUsers.forEach((lastSeen, userId) => {
    if (lastSeen < cutoff) activeUsers.delete(userId);
  });
  metrics.push(createMetric('activeUsers', activeUsers.size, '{users}', 'gauge', 'asInt'));

  metrics.push(createMetric('pizzasSold', pizzas.sold, '1', 'sum', 'asInt'));
  metrics.push(createMetric('pizzaCreationFailures', pizzas.failures, '1', 'sum', 'asInt'));
  metrics.push(createMetric('revenue', pizzas.revenue, '1', 'sum', 'asDouble'));
  if (pizzas.latencyCount > 0) {
    metrics.push(createMetric('pizzaCreationLatency', pizzas.latencyTotalMs / pizzas.latencyCount, 'ms', 'gauge', 'asDouble'));
    pizzas.latencyTotalMs = 0;
    pizzas.latencyCount = 0;
  }

  // Average service endpoint latency since the last report
  if (latencyCount > 0) {
    metrics.push(createMetric('serviceLatency', latencyTotalMs / latencyCount, 'ms', 'gauge', 'asDouble'));
    latencyTotalMs = 0;
    latencyCount = 0;
  }

  metrics.push(createMetric('cpuUsagePercentage', getCpuUsagePercentage(), '%', 'gauge', 'asDouble'));
  metrics.push(createMetric('memoryUsagePercentage', getMemoryUsagePercentage(), '%', 'gauge', 'asDouble'));

  sendMetricToGrafana(metrics);
}, 10000).unref();

function createMetric(metricName, metricValue, metricUnit, metricType, valueType, attributes) {
  attributes = { ...attributes, source: config.source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]: metricValue,
          timeUnixNano: Date.now() * 1000000,
          attributes: [],
        },
      ],
    },
  };

  Object.keys(attributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key: key,
      value: { stringValue: attributes[key] },
    });
  });


  switch(metricType) {
    case 'sum':
      metric[metricType].aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
      metric[metricType].isMonotonic = true;
      break;
    case 'gauge':
      break;
  }

  return metric;
}

function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };

  fetch(`${config.endpointUrl}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${config.accountId}:${config.apiKey}`, 'Content-Type': 'application/json' },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
    })
    .catch((error) => {
      console.error('Error pushing metrics:', error);
    });
}

function getCpuUsagePercentage() {
  const cpuUsage = (os.loadavg()[0] / os.cpus().length) * 100;
  return Number(cpuUsage.toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return Number(memoryUsage.toFixed(2));
}

module.exports = { requestTracker, pizzaPurchase };