import {inject} from '@loopback/context';
import {
  FindRoute,
  HttpErrors,
  InvokeMethod,
  ParseParams,
  Reject,
  RequestContext,
  RestBindings,
  Send,
  SequenceHandler,
} from '@loopback/rest';

import {Account} from '@pokt-network/pocket-js/dist/keybase/models/account';

const logger = require('./services/logger');

const pocketJS = require('@pokt-network/pocket-js');
const {Pocket, Configuration, HttpRpcProvider} = pocketJS;

const shortID = require('shortid');
const SequenceActions = RestBindings.SequenceActions;

export class GatewaySequence implements SequenceHandler {
  constructor(
    @inject('dispatchURL') private dispatchURL: string,
    @inject('pocketSessionBlockFrequency') private pocketSessionBlockFrequency: number,
    @inject('pocketBlockTime') private pocketBlockTime: number,
    @inject('clientPrivateKey') private clientPrivateKey: string,
    @inject('clientPassphrase') private clientPassphrase: string,
    @inject(SequenceActions.FIND_ROUTE) protected findRoute: FindRoute,
    @inject(SequenceActions.PARSE_PARAMS) protected parseParams: ParseParams,
    @inject(SequenceActions.INVOKE_METHOD) protected invoke: InvokeMethod,
    @inject(SequenceActions.SEND) public send: Send,
    @inject(SequenceActions.REJECT) public reject: Reject,
  ) {}

  async handle(context: RequestContext) {
    try {

      // Create the Pocket instance
      const dispatchers = [];

      if (this.dispatchURL.indexOf(",")) {
        const dispatcherArray = this.dispatchURL.split(",");
        dispatcherArray.forEach(function(dispatcher) {
          dispatchers.push(new URL(dispatcher));
        });
      } else {
        dispatchers.push(new URL(this.dispatchURL));
      }

      const configuration = new Configuration(
        0,
        100000,
        0,
        120000,
        false,
        this.pocketSessionBlockFrequency,
        this.pocketBlockTime,
        undefined,
        undefined,
        false,
      );
      const rpcProvider = new HttpRpcProvider(dispatchers);
      const pocket = new Pocket(dispatchers, rpcProvider, configuration);
      
      context.bind('pocketInstance').to(pocket);
      context.bind('pocketConfiguration').to(configuration);

      // Unlock primary client account for relay signing
      try {
        const importAccount = await pocket.keybase.importAccount(
          Buffer.from(this.clientPrivateKey, 'hex'),
          this.clientPassphrase,
        );
        if (importAccount instanceof Account) {
          await pocket.keybase.unlockAccount(
            importAccount.addressHex,
            this.clientPassphrase,
            0,
          );
        }
      } catch (e) {
        logger.log('error', e);
        throw new HttpErrors.InternalServerError(
          'Unable to import or unlock base client account',
        );
      }

      const {request, response} = context;

      // Record the host, user-agent, and origin for processing
      context.bind('host').to(request.headers['host']);
      context.bind('userAgent').to(request.headers['user-agent']);
      context.bind('origin').to(request.headers['origin']);
      context.bind('contentType').to(request.headers['content-type']);
      context.bind('relayPath').to(request.headers['relay-path']);
      context.bind('httpMethod').to(request.method);

      let secretKey = '';
      // SecretKey passed in via basic http auth
      if (request.headers['authorization']) {
        const base64Credentials = request.headers['authorization'].split(
          ' ',
        )[1];
        const credentials = Buffer.from(base64Credentials, 'base64')
          .toString('ascii')
          .split(':');
        if (credentials[1]) {
          secretKey = credentials[1];
        }
      }
      context.bind('secretKey').to(secretKey);

      // Unique ID for log tracing
      context.bind('requestID').to(shortID.generate());

      // Custom routing for blockchain paths:
      // If it finds an extra path on the end of the request, slice off the path 
      // and convert the slashes to tildes for processing in the v1.controller
      if (
        request.method === "POST" &&
        (
          // Matches either /v1/lb/LOADBALANCER_ID or /v1/APPLICATION_ID
          request.url.match(/^\/v1\/lb\//) ||
          request.url.match(/^\/v1\/[0-9a-zA-Z]{24}\//)
        )
      ) {
        if (request.url.match(/^\/v1\/lb\//)) {
          request.url = `/v1/lb/${request.url.slice(7).replace(/\//gi, '~')}`;
        } else if (request.url.match(/^\/v1\/[0-9a-z]{24}\//)) {
          request.url = `${request.url.slice(0,28)}${request.url.slice(28).replace(/\//gi, '~')}`;
        }
      }

      const route = this.findRoute(request);
      const args = await this.parseParams(request, route);
      const result = await this.invoke(route, args);
      this.send(response, result);
    } catch (err) {
      this.reject(context, err);
    }
  }
}
