targetScope = 'resourceGroup'

@description('Name of the Azure Health Model this discovery rule belongs to.')
param modelName string

@description('Authentication setting the discovery rule queries Azure through.')
param authenticationSettingName string

@description('Application Insights resource whose topology is discovered, sourced from the relationship module so discovery runs last.')
param discoverySourceId string

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = {
  name: modelName
}

resource appInsightsDiscovery 'Microsoft.CloudHealth/healthmodels/discoveryrules@2026-05-01-preview' = {
  parent: model
  name: 'discover-app-insights'
  properties: {
    displayName: 'Application Insights topology'
    authenticationSetting: authenticationSettingName
    addRecommendedSignals: 'Enabled'
    addResourceHealthSignal: 'Disabled'
    discoverRelationships: 'Enabled'
    specification: {
      kind: 'ApplicationInsightsTopology'
      applicationInsightsResourceId: discoverySourceId
    }
  }
}

output discoveryRuleId string = appInsightsDiscovery.id
