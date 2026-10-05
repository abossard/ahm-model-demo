targetScope = 'resourceGroup'

param name string
param location string
param environmentId string
param identityId string
param identityClientId string
param identityName string
param registryLoginServer string
param image string
param placeholderImage string
param postgresHost string
param postgresDatabase string
@secure()
param applicationInsightsConnectionString string
param tags object

module app 'container-app.bicep' = {
  name: 'survey-container'
  params: {
    name: name
    location: location
    serviceName: 'survey'
    environmentId: environmentId
    identityId: identityId
    registryLoginServer: registryLoginServer
    image: image
    placeholderImage: placeholderImage
    targetPort: 8080
    external: true
    cpu: '0.5'
    memory: '1Gi'
    tags: tags
    env: [
      {
        name: 'AZURE_CLIENT_ID'
        value: identityClientId
      }
      {
        name: 'POSTGRES_HOST'
        value: postgresHost
      }
      {
        name: 'POSTGRES_DATABASE'
        value: postgresDatabase
      }
      {
        name: 'POSTGRES_USER'
        value: identityName
      }
      {
        name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
        value: applicationInsightsConnectionString
      }
      {
        name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING'
        value: 'Authorization=AAD;ClientId=${identityClientId}'
      }
      {
        name: 'OTEL_SERVICE_NAME'
        value: 'ahm-survey'
      }
    ]
  }
}

output containerAppName string = app.outputs.containerAppName
output containerAppId string = app.outputs.containerAppId
output fqdn string = app.outputs.fqdn
