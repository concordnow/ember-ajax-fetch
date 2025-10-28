import Service from '@ember/service';
import { getOwner } from '@ember/application';
import FetchRequestMixin from '../mixins/fetch-request';

/**
 * @class FetchService
 */
const FetchService = Service.extend(FetchRequestMixin, {
  /**
   * Whether fetch monitoring is enabled
   * @property {boolean} enableFetchMonitoring
   * @default false
   * @public
   */
  enableFetchMonitoring: false,

  /**
   * Fetch monitoring configuration
   * @property {Object} fetchMonitorConfig
   * @default null
   * @public
   */
  fetchMonitorConfig: null,

  /**
   * Initialize the service with configuration from environment
   * @method init
   * @private
   */
  init() {
    this._super(...arguments);

    // Get configuration from environment
    const config = getOwner(this).resolveRegistration('config:environment');
    const emberAjaxFetchConfig = config['ember-ajax-fetch'] || {};

    // Set monitoring configuration
    this.set('enableFetchMonitoring', emberAjaxFetchConfig.enableFetchMonitoring || false);
    this.set('fetchMonitorConfig', emberAjaxFetchConfig.fetchMonitorConfig || null);
  },
});

export default FetchService;
