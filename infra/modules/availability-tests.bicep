targetScope = 'resourceGroup'

@description('Primary Azure region for the demo workload.')
param location string

@description('Name prefix shared by the regionally scoped resources.')
param namePrefix string

@description('Application Insights component the tests report into.')
param applicationInsightsName string

@description('Public URL of the Health Pulse website.')
param appUrl string

@description('Health check URL of the Azure MCP server. The server answers /health without authentication.')
param mcpHealthUrl string

// Must match health-model-entities.bicep's availabilityTestName; tests/test_infra.py asserts they agree.
param availabilityTestName string = 'Health Pulse home page'
param mcpAvailabilityTestName string = 'Azure MCP health'
param availabilityTestFrequencySeconds int = 300
param availabilityTestLocations array = [
  'emea-gb-db3-azr'
  'emea-nl-ams-azr'
  'us-va-ash-azr'
]

@description('Tags applied to all taggable resources.')
param tags object

var homeTestName = 'wt-${namePrefix}-home'
var mcpTestName = 'wt-${namePrefix}-mcp'

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

// Always-on synthetic traffic. Plain GET of the UI only: it keeps a replica warm so the
// container app's CPU, memory and response-time metrics report real values, and it feeds
// Application Insights availability without writing anything.
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

output availabilityTestName string = availabilityTestName

// The MCP server cannot export its own requests: its telemetry exporter has no credential and Application Insights
// accepts only Entra tokens. The probe gives the health model real evidence of the server.
resource mcpAvailabilityTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: mcpTestName
  location: location
  tags: union(tags, {
    'hidden-link:${applicationInsights.id}': 'Resource'
  })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: mcpTestName
    Name: mcpAvailabilityTestName
    Description: 'Side-effect-free GET of the Azure MCP server health check.'
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
      RequestUrl: mcpHealthUrl
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

output mcpAvailabilityTestName string = mcpAvailabilityTestName
