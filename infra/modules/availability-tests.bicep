targetScope = 'resourceGroup'

@description('Primary Azure region for the demo workload.')
param location string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Application Insights component the tests report into.')
param applicationInsightsName string

@description('Public URL of the Health Pulse website.')
param appUrl string

// Must match health-model-entities.bicep's availabilityTestName; tests/test_app.py asserts they agree.
param availabilityTestName string = 'Health Pulse home page'
param availabilityTestFrequencySeconds int = 300
param availabilityTestLocations array = [
  'emea-gb-db3-azr'
  'emea-nl-ams-azr'
  'us-va-ash-azr'
]
param journeyAvailabilityTestEnabled bool = false

@description('Tags applied to all taggable resources.')
param tags object

var homeTestName = 'wt-${namePrefix}-home'
var journeyTestName = 'wt-${namePrefix}-journey'

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

// Always-on synthetic traffic. Plain GET of the UI only: it keeps a replica warm so the
// container app's CPU, memory and response-time metrics report real values, and it feeds
// Application Insights availability without writing to the Queue or PostgreSQL.
resource homeAvailabilityTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: homeTestName
  location: location
  tags: union(tags, {
    'hidden-link:${applicationInsights.id}': 'Resource'
  })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: homeTestName
    Name: availabilityTestName
    Description: 'Side-effect-free GET of the Health Pulse UI.'
    Enabled: true
    Frequency: availabilityTestFrequencySeconds
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [
      for locationId in availabilityTestLocations: {
        Id: locationId
      }
    ]
    Request: {
      RequestUrl: appUrl
      HttpVerb: 'GET'
      ParseDependentRequests: false
      FollowRedirects: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 7
    }
  }
}

// Filming-only traffic. This POST runs the full request journey, so it writes to the Queue
// and PostgreSQL on every execution. That is exactly what makes the Storage signals report
// real values on camera, so it ships disabled and is enabled only while filming.
resource journeyAvailabilityTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: journeyTestName
  location: location
  tags: union(tags, {
    'hidden-link:${applicationInsights.id}': 'Resource'
  })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: journeyTestName
    Name: 'Health Pulse request journey'
    Description: 'Filming-only POST that exercises the Queue and PostgreSQL write path. Disable it between takes.'
    Enabled: journeyAvailabilityTestEnabled
    Frequency: availabilityTestFrequencySeconds
    Timeout: 60
    Kind: 'standard'
    RetryEnabled: false
    Locations: [
      for locationId in availabilityTestLocations: {
        Id: locationId
      }
    ]
    Request: {
      RequestUrl: '${appUrl}api/demo-request'
      HttpVerb: 'POST'
      ParseDependentRequests: false
      FollowRedirects: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
    }
  }
}

output availabilityTestName string = availabilityTestName
output availabilityTestUrl string = appUrl
