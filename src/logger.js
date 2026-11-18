const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js').logging;

// Any field whose name matches this is masked before it leaves the service
const SENSITIVE_KEY = /password|token|jwt|apikey|authorization|secret/i;

// Holds the current request so DB and factory logs can report the user without threading req through every call
const requestContext = new AsyncLocalStorage();

class Logger {
  // Don't ship logs while Jest is running so tests don't flood Grafana
  enabled = process.env.NODE_ENV !== 'test';

  // Express middleware: logs every request once the response has finished
  httpLogger = (req, res, next) => {
    let resBody;
    const send = res.send;
    res.send = (body) => {
      // res.json calls back into res.send, so keep the first body we see
      if (resBody === undefined) resBody = body;
      return send.call(res, body);
    };

    res.on('finish', () => {
      this.log(this.statusToLogLevel(res.statusCode), 'http', {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        authorized: !!req.headers.authorization,
        user: this.userInfo(req.user),
        reqBody: req.body,
        resBody,
      });
    });

    requestContext.run(req, next);
  };

  dbLogger(sql) {
    this.log('info', 'db', { sql, user: this.currentUser() });
  }

  factoryLogger(statusCode, reqBody, resBody) {
    this.log(this.statusToLogLevel(statusCode), 'factory', { statusCode, user: this.currentUser(), reqBody, resBody });
  }

  exceptionLogger(err, req) {
    const statusCode = err.statusCode ?? 500;
    this.log(this.statusToLogLevel(statusCode), 'exception', {
      message: err.message,
      statusCode,
      method: req?.method,
      path: req?.originalUrl,
      user: this.userInfo(req?.user),
      stack: err.stack,
    });
  }

  log(level, type, logData) {
    const labels = { component: config.source, level, type };
    const values = [this.nowString(), this.sanitize(logData)];
    this.sendLogToGrafana({ streams: [{ stream: labels, values: [values] }] });
  }

  currentUser() {
    return this.userInfo(requestContext.getStore()?.user);
  }

  userInfo(user) {
    return user ? { id: user.id, name: user.name, email: user.email } : undefined;
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    // Loki wants nanoseconds; multiplying by 1e6 overflows Number precision, so pad the string instead
    return `${Date.now()}000000`;
  }

  sanitize(logData) {
    return JSON.stringify(logData, (key, value) => {
      if (SENSITIVE_KEY.test(key)) return '*****';
      // Response bodies arrive as JSON strings from res.json, so parse them to mask their fields too
      if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    });
  }

  sendLogToGrafana(event) {
    if (!this.enabled) return;
    fetch(config.endpointUrl, {
      method: 'POST',
      body: JSON.stringify(event),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.accountId}:${config.apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) console.log(`Failed to send log to Grafana: HTTP ${res.status}`);
      })
      .catch((err) => console.log('Failed to send log to Grafana:', err.message));
  }
}

module.exports = new Logger();
