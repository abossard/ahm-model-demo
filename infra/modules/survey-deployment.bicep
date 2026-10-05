targetScope = 'resourceGroup'

@description('Existing azd environment; does not provision its platform resources.')
param environmentName string
param location string
param healthModelLocation string
param containerEnvironmentName string
param workloadIdentityName string
param registryName string
param postgresServerName string
param postgresDatabaseName string
param applicationInsightsName string
param workspaceName string
@description('Previously built and verified immutable survey image digest.')
param surveyImage string

var tags = {
  'azd-env-name': environmentName
  workload: 'azure-health-model-demo'
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerEnvironmentName
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workloadIdentityName
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: postgresServerName
}
resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

module survey 'survey-platform.bicep' = {
  name: 'survey-platform'
  params: {
    name: 'ca-${environmentName}-survey'
    location: location
    environmentId: environment.id
    identityId: identity.id
    identityClientId: identity.properties.clientId
    identityName: identity.name
    registryLoginServer: registry.properties.loginServer
    image: surveyImage
    placeholderImage: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
    postgresHost: postgres.properties.fullyQualifiedDomainName
    postgresDatabase: postgresDatabaseName
    applicationInsightsConnectionString: insights.properties.ConnectionString
    tags: tags
  }
}

module model 'survey-health-model.bicep' = {
  name: 'survey-health-model'
  params: {
    modelName: 'hm-${environmentName}-survey'
    healthModelLocation: healthModelLocation
    containerAppId: survey.outputs.containerAppId
    postgresId: postgres.id
    workspaceId: workspace.id
    applicationInsightsId: insights.id
    tags: tags
  }
}

output SERVICE_SURVEY_NAME string = survey.outputs.containerAppName
output SERVICE_SURVEY_ID string = survey.outputs.containerAppId
output SERVICE_SURVEY_FQDN string = survey.outputs.fqdn
output SURVEY_HEALTH_MODEL_NAME string = model.outputs.modelName
output SURVEY_HEALTH_MODEL_ID string = model.outputs.modelId
