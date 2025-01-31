import crypto from 'crypto'
import os from 'os'
import path from 'path'
import process from 'process'
import Redis from 'ioredis'
import pg from 'pg'
import { BootMixin } from '@loopback/boot'
import { ApplicationConfig } from '@loopback/core'
import { RepositoryMixin } from '@loopback/repository'
import { RestApplication, HttpErrors } from '@loopback/rest'
import { ServiceMixin } from '@loopback/service-proxy'
import { InfluxDB, DEFAULT_WriteOptions, WriteApi } from '@influxdata/influxdb-client'

import AatPlans from './config/aat-plans.json'
import { getPocketInstance } from './config/pocket-config'
import { GatewaySequence } from './sequence'
import { Cache } from './services/cache'
import { getRDSCertificate } from './utils/cache'
const logger = require('./services/logger')

require('log-timestamp')
require('dotenv').config()

// Portal API
export class PocketGatewayApplication extends BootMixin(ServiceMixin(RepositoryMixin(RestApplication))) {
  constructor(options: ApplicationConfig = {}) {
    super(options)
    this.sequence(GatewaySequence)
    this.static('/', path.join(__dirname, '../public'))

    this.projectRoot = __dirname
    this.bootOptions = {
      controllers: {
        dirs: ['controllers'],
        extensions: ['.controller.js'],
        nested: true,
      },
    }

    this.bind('configuration.environment.load').to(typeof options?.env?.load !== undefined ? options.env.load : true)
    this.bind('configuration.environment.values').to(options.env.values || {})
  }

  async loadPocket(): Promise<void> {
    // Requirements; for Production these are stored in GitHub repo secrets
    //
    // For Dev, you need to pass them in via .env file
    // TODO: Add env as a type
    const {
      NODE_ENV,
      GATEWAY_CLIENT_PRIVATE_KEY,
      GATEWAY_CLIENT_PASSPHRASE,
      DATABASE_ENCRYPTION_KEY,
      REDIS_PORT,
      REMOTE_REDIS_ENDPOINT,
      LOCAL_REDIS_ENDPOINT,
      PSQL_CONNECTION,
      PSQL_CERTIFICATE,
      DISPATCH_URL,
      POCKET_RELAY_RETRIES,
      DEFAULT_SYNC_ALLOWANCE,
      DEFAULT_LOG_LIMIT_BLOCKS,
      AAT_PLAN,
      // These arrays must have the same length and the index value on each array
      // correspond to the same influx instance
      INFLUX_URLS,
      INFLUX_TOKENS,
      INFLUX_ORGS,
      ARCHIVAL_CHAINS,
      ALWAYS_REDIRECT_TO_ALTRUISTS,
      ALTRUIST_ONLY_CHAINS,
      REDIS_LOCAL_TTL_FACTOR,
      RATE_LIMITER_URL,
      RATE_LIMITER_TOKEN,
      GATEWAY_HOST,
    }: // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any = await this.get('configuration.environment.values')

    const environment: string = NODE_ENV || 'production'
    const dispatchURL: string = DISPATCH_URL || ''
    const clientPrivateKey: string = GATEWAY_CLIENT_PRIVATE_KEY || ''
    const clientPassphrase: string = GATEWAY_CLIENT_PASSPHRASE || ''
    const relayRetries: string = POCKET_RELAY_RETRIES || ''
    const databaseEncryptionKey: string = DATABASE_ENCRYPTION_KEY || ''
    const defaultSyncAllowance: number = parseInt(DEFAULT_SYNC_ALLOWANCE) || -1
    const defaultLogLimitBlocks: number = parseInt(DEFAULT_LOG_LIMIT_BLOCKS) || 10000
    const aatPlan = AAT_PLAN || AatPlans.PREMIUM
    const archivalChains: string[] = (ARCHIVAL_CHAINS || '').replace(' ', '').split(',')
    const alwaysRedirectToAltruists: boolean = ALWAYS_REDIRECT_TO_ALTRUISTS === 'true'
    const altruistOnlyChains: string[] = (ALTRUIST_ONLY_CHAINS || '').replace(' ', '').split(',')
    const ttlFactor = parseFloat(REDIS_LOCAL_TTL_FACTOR) || 1
    const rateLimiterURL: string = RATE_LIMITER_URL || ''
    const rateLimiterToken: string = RATE_LIMITER_TOKEN || ''
    const gatewayHost: string = GATEWAY_HOST || 'localhost'

    const influxURLs = (INFLUX_URLS || '').split(',')
    const influxTokens = (INFLUX_TOKENS || '').split(',')
    const influxOrgs = (INFLUX_ORGS || '').split(',')
    if (aatPlan !== AatPlans.PREMIUM && !AatPlans.values.includes(aatPlan)) {
      throw new HttpErrors.InternalServerError('Unrecognized AAT Plan')
    }

    const dispatchers = dispatchURL.indexOf(',') ? dispatchURL.split(',') : [dispatchURL]

    const pocket = await getPocketInstance(dispatchers, clientPrivateKey)

    this.bind('clientPrivateKey').to(clientPrivateKey)
    this.bind('clientPassphrase').to(clientPassphrase)
    // I know what you're thinking: "why pass the dispatchURL raw string and not parsed as URL() array?".
    // Well doing so for some reason injects service nodes urls instead of the dispatcher urls and
    // those change per request, so let's keep it this way until loopback figures it out.
    this.bind('dispatchURL').to(dispatchURL)
    this.bind('relayer').to(pocket)
    this.bind('relayRetries').to(parseInt(relayRetries))
    this.bind('logger').to(logger)
    this.bind('defaultSyncAllowance').to(defaultSyncAllowance)
    this.bind('defaultLogLimitBlocks').to(defaultLogLimitBlocks)
    this.bind('alwaysRedirectToAltruists').to(alwaysRedirectToAltruists)
    this.bind('altruistOnlyChains').to(altruistOnlyChains)
    this.bind('rateLimiterURL').to(rateLimiterURL)
    this.bind('rateLimiterToken').to(rateLimiterToken)
    this.bind('gatewayHost').to(gatewayHost)

    const redisPort: string = REDIS_PORT || ''

    // Load remote Redis for cache
    const remoteRedisEndpoint: string = REMOTE_REDIS_ENDPOINT || ''

    const remoteRedisConfig = {
      host: remoteRedisEndpoint,
      port: parseInt(redisPort),
    }

    const remoteRedis =
      environment === 'production'
        ? new Redis.Cluster([remoteRedisConfig], {
            scaleReads: 'slave',
          })
        : new Redis(remoteRedisConfig.port, remoteRedisConfig.host)

    // Load local Redis for cache
    const localRedisEndpoint: string = LOCAL_REDIS_ENDPOINT || ''

    const localRedisConfig = {
      host: localRedisEndpoint,
      port: parseInt(redisPort),
    }

    const localRedis = new Redis(localRedisConfig.port, localRedisConfig.host)

    const cache = new Cache(remoteRedis as Redis, localRedis, ttlFactor)

    this.bind('cache').to(cache)

    // New metrics postgres for error recording
    const psqlConnection: string = PSQL_CONNECTION || ''
    const psqlCertificate: string = PSQL_CERTIFICATE || ''

    let rdsCertificate: string

    if (environment === 'production') {
      rdsCertificate = await getRDSCertificate(remoteRedis as Redis, psqlCertificate)
    }

    const pgPool = new pg.Pool({
      // Do not include ssl settings in the connectionString
      connectionString: psqlConnection,
      ssl:
        environment === 'production' || environment === 'staging'
          ? {
              ca: rdsCertificate,
              requestCert: true,
              rejectUnauthorized: false,
            }
          : false,
    })

    this.bind('pgPool').to(pgPool)

    // Influx DB
    const influxBucket = environment === 'production' ? 'mainnetRelay' : 'mainnetRelayStaging'
    const writeOptions = { ...DEFAULT_WriteOptions, batchSize: 4000 }
    const influxWriteAPIs: WriteApi[] = []
    // TODO: Remove once influx tests are over
    for (const idx in influxURLs) {
      influxWriteAPIs.push(
        new InfluxDB({ url: influxURLs[idx], token: influxTokens[idx] }).getWriteApi(
          influxOrgs[idx],
          influxBucket,
          'ms',
          writeOptions
        )
      )
    }
    this.bind('influxWriteAPIs').to(influxWriteAPIs)

    // Create a UID for this process
    const parts = [os.hostname(), process.pid, +new Date()]
    const hash = crypto.createHash('md5').update(parts.join(''))

    this.bind('processUID').to(hash.digest('hex'))
    this.bind('databaseEncryptionKey').to(databaseEncryptionKey)
    this.bind('aatPlan').to(aatPlan)
    this.bind('archivalChains').to(archivalChains)
  }
}
