import { sleep, check, group, fail } from 'k6'
import http from 'k6/http'
import jsonpath from 'https://jslib.k6.io/jsonpath/1.0.2/index.js'

export const options = {
  cloud: {
    distribution: { 'amazon:us:ashburn': { loadZone: 'amazon:us:ashburn', percent: 100 } },
    apm: [],
  },
  thresholds: {},
  scenarios: {
    Scenario_1: {
      executor: 'ramping-vus',
      gracefulStop: '30s',
      stages: [
        { target: 5, duration: '30s' },
        { target: 15, duration: '1m' },
        { target: 10, duration: '30s' },
        { target: 0, duration: '30s' },
      ],
      gracefulRampDown: '30s',
      exec: 'scenario_1',
    },
  },
}

// Browser headers recorded in the HAR; pass a token to add the Authorization header
function headers(token, extra = {}) {
  const h = {
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'en-US,en;q=0.9,es-US;q=0.8,es;q=0.7',
    'content-type': 'application/json',
    origin: 'https://pizza.garrett-webster.com',
    priority: 'u=1, i',
    'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    ...extra,
  }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

export function scenario_1() {
  let response

  const vars = {}

  group('Purchase pizza - https://pizza.garrett-webster.com/', function () {
    // Login
    response = http.put(
      'https://pizza-service.garrett-webster.com/api/auth',
      '{"email":"d@jwt.com","password":"diner"}',
      { headers: headers() }
    )
    if (!check(response, { 'status equals 200': (r) => r.status.toString() === '200' })) {
      console.log(response.body)
      fail('Login was *not* 200')
    }
    vars['token'] = jsonpath.query(response.json(), '$.token')[0]

    sleep(14.6)

    // Get menu
    response = http.get('https://pizza-service.garrett-webster.com/api/order/menu', {
      headers: headers(vars['token']),
    })

    // Get franchises
    response = http.get('https://pizza-service.garrett-webster.com/api/franchise?page=0&limit=20&name=*', {
      headers: headers(vars['token']),
    })
    sleep(8.5)

    // Get user info
    response = http.get('https://pizza-service.garrett-webster.com/api/user/me', {
      headers: headers(vars['token']),
    })
    sleep(23.3)

    // Order pizza
    response = http.post(
      'https://pizza-service.garrett-webster.com/api/order',
      '{"items":[{"menuId":1,"description":"Veggie","price":0.0038}],"storeId":"1","franchiseId":1}',
      { headers: headers(vars['token']) }
    )
    if (!check(response, { 'order status 200': (r) => r.status === 200 })) {
      console.log(response.body)
      fail('Order was *not* 200')
    }
    vars['pizzaJwt'] = jsonpath.query(response.json(), '$.jwt')[0]
    sleep(1.6)

    // Verify
    response = http.post(
      'https://pizza-factory.cs329.click/api/order/verify',
      JSON.stringify({ jwt: vars['pizzaJwt'] }),
      {
        headers: headers(vars['token'], {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-storage-access': 'active',
        }),
      }
    )
    check(response, { 'verify status 200': (r) => r.status === 200 })
  })
}
