import { ClickHouse } from 'clickhouse'
import PQueue from 'p-queue'
import { generateUniqueId } from '@loopback/context'

export type ClickHouseCredentials = {
  user: string
  password: string
  database: string
  url: string
}

// ClickHouse API tends to fail with many concurrent requests, and the official documentation
// recommends batching over single-inserts. This library provides a simple wrapper with two main
// features:
// 1. Support for batching inserts, as per clickHouse recomendation
// 2. Control the concurrency of requests, to avoid concurrency issues
export class ClickHouseLib {
  queue: PQueue
  clickHouse: ClickHouse
  itemsMap: Map<string, object[]>
  batchSize: number

  constructor(
    { url, user, password, database }: ClickHouseCredentials,
    batchSize = 4000,
    concurrency = 1,
    intervalSec = 60
  ) {
    this.clickHouse = new ClickHouse({
      url: url,
      port: 8123,
      debug: false,
      basicAuth: {
        username: user,
        password: password,
      },
      isUseGzip: false,
      trimQuery: false,
      usePost: false,
      format: 'json',
      raw: false,
      config: {
        session_id: generateUniqueId(),
        session_timeout: 60,
        output_format_json_quote_64bit_integers: 0,
        enable_http_compression: 0,
        database: database,
      },
    })
    this.queue = new PQueue({ concurrency })
    this.batchSize = batchSize
    this.itemsMap = new Map<string, object[]>()

    // Prevent stale data due to inactivity
    setInterval(() => this.bulkInsert(true), intervalSec * 1000)
  }

  insert(query: string, data: object): void {
    const items = this.itemsMap.get(query)
    if (!items) {
      this.itemsMap.set(query, [data])
    } else {
      items.push(data)
    }

    this.bulkInsert(false)
  }

  private bulkInsert(force: boolean) {
    this.itemsMap.forEach(async (items, query) => {
      if (!force && items.length < this.batchSize) {
        return
      }

      await this.queue.add(() => this.clickHouse.insert(query, items).toPromise())
      this.itemsMap.delete(query)
    })
  }
}
