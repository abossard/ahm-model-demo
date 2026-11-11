targetScope = 'resourceGroup'

extension microsoftGraphV1

@description('Name of the azd environment. Seeds the unique names of both app registrations.')
param environmentName string

@description('Public URL of the web app, with a trailing slash. It is a single-page-app redirect URI.')
param webUrl string

@description('Object ID of the workload user-assigned identity. Both app registrations trust it instead of holding a secret.')
param identityPrincipalId string

@description('Audience of the federated credential exchange. Differs in sovereign clouds.')
param tokenExchangeAudience string = 'api://AzureADTokenExchange'

@description('Pre-authorize the Azure CLI for the web API scope, so a signed-in developer can run "az account get-access-token --scope <ENTRA_API_SCOPE>" and call the API as themselves. Any user in the tenant can then script the API, so it is off unless needed. The MCP app is never affected.')
param allowAzureCli bool = false

var webUniqueName = 'ahm-${environmentName}-web'
var mcpUniqueName = 'ahm-${environmentName}-mcp'
var webScopeValue = 'access_as_user'
var mcpScopeValue = 'Mcp.Tools.ReadWrite'
var webScopeId = guid(webUniqueName, webScopeValue)
var mcpScopeId = guid(mcpUniqueName, mcpScopeValue)

// Well-known Microsoft first-party APIs. Ids are the same in every tenant.
var armApplicationId = '797f4846-ba00-4fd7-ba43-dac1f8f63013'
var armUserImpersonationId = '41094075-9dad-400e-a0bd-54e686782033'
var logAnalyticsApplicationId = 'ca7f3f0b-7d91-482c-8e09-c5d840d0eac5'
var logAnalyticsDataReadId = 'e8dac03d-d467-4a7e-9293-9cca7df08b31'

// The Azure CLI public client. It is the only client ever pre-authorized for the web scope, and never for the MCP scope.
var azureCliApplicationId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'

var armAccess = {
  resourceAppId: armApplicationId
  resourceAccess: [
    {
      id: armUserImpersonationId
      type: 'Scope'
    }
  ]
}

// Each registration points at the other one (the web app needs the MCP scope, the MCP server pre-authorizes the web
// app) and at itself (identifierUris). An application id exists only after creation, so each app is declared twice
// with the same uniqueName: the first declaration creates it, the second one sets everything that needs an id.
resource mcpCreated 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: mcpUniqueName
  displayName: 'AHM Demo ${environmentName} MCP'
  signInAudience: 'AzureADMyOrg'
}

resource webCreated 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: webUniqueName
  displayName: 'AHM Demo ${environmentName} web'
  signInAudience: 'AzureADMyOrg'
}

resource mcpApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: mcpUniqueName
  displayName: 'AHM Demo ${environmentName} MCP'
  signInAudience: 'AzureADMyOrg'
  identifierUris: [
    'api://${mcpCreated.appId}'
  ]
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: mcpScopeId
        type: 'User'
        value: mcpScopeValue
        isEnabled: true
        adminConsentDisplayName: 'Call the Azure MCP server'
        adminConsentDescription: 'Lets the web app call the Azure MCP server on behalf of the signed-in user.'
        userConsentDisplayName: 'Call the Azure MCP server'
        userConsentDescription: 'Lets the app call the Azure MCP server on your behalf.'
      }
    ]
    preAuthorizedApplications: [
      {
        appId: webCreated.appId
        delegatedPermissionIds: [
          mcpScopeId
        ]
      }
    ]
  }
  requiredResourceAccess: [
    armAccess
    {
      resourceAppId: logAnalyticsApplicationId
      resourceAccess: [
        {
          id: logAnalyticsDataReadId
          type: 'Scope'
        }
      ]
    }
  ]
}

resource webApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: webUniqueName
  displayName: 'AHM Demo ${environmentName} web'
  signInAudience: 'AzureADMyOrg'
  identifierUris: [
    'api://${webCreated.appId}'
  ]
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: webScopeId
        type: 'User'
        value: webScopeValue
        isEnabled: true
        adminConsentDisplayName: 'Use the app as the signed-in user'
        adminConsentDescription: 'Lets the single-page app call the web API as the signed-in user.'
        userConsentDisplayName: 'Use the app as you'
        userConsentDescription: 'Lets the app call its API on your behalf.'
      }
    ]
    preAuthorizedApplications: allowAzureCli
      ? [
          {
            appId: azureCliApplicationId
            delegatedPermissionIds: [
              webScopeId
            ]
          }
        ]
      : []
  }
  spa: {
    redirectUris: [
      webUrl
      'http://localhost:8080/'
    ]
  }
  requiredResourceAccess: [
    armAccess
    {
      resourceAppId: mcpCreated.appId
      resourceAccess: [
        {
          id: mcpScopeId
          type: 'Scope'
        }
      ]
    }
    {
      resourceAppId: webCreated.appId
      resourceAccess: [
        {
          id: webScopeId
          type: 'Scope'
        }
      ]
    }
  ]
}

resource mcpServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: mcpCreated.appId
}

resource webServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: webCreated.appId
}

// The apps authenticate to Entra as the workload identity, so neither holds a client secret or certificate.
resource mcpWorkloadCredential 'Microsoft.Graph/applications/federatedIdentityCredentials@v1.0' = {
  name: '${mcpUniqueName}/workload-identity'
  audiences: [
    tokenExchangeAudience
  ]
  description: 'The workload managed identity signs the on-behalf-of exchange of the MCP server.'
  issuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
  subject: identityPrincipalId
  dependsOn: [
    mcpApp
  ]
}

resource webWorkloadCredential 'Microsoft.Graph/applications/federatedIdentityCredentials@v1.0' = {
  name: '${webUniqueName}/workload-identity'
  audiences: [
    tokenExchangeAudience
  ]
  description: 'The workload managed identity signs the on-behalf-of exchange of the web app.'
  issuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
  subject: identityPrincipalId
  dependsOn: [
    webApp
  ]
}

@description('Directory (tenant) id both registrations belong to.')
output tenantId string = tenant().tenantId

@description('Client id of the web app registration. The single-page app signs in with it.')
output webClientId string = webCreated.appId

@description('Scope the browser requests for the web API.')
output webApiScope string = 'api://${webCreated.appId}/${webScopeValue}'

@description('Client id of the MCP server registration.')
output mcpClientId string = mcpCreated.appId

@description('Scope the web app requests on behalf of the user for the MCP server.')
output mcpScope string = 'api://${mcpCreated.appId}/${mcpScopeValue}'
