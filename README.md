# docker2le
log shipper from docker to logentries

# Dependencies
 - Node.js 7.6.0
 - dockerode


# How to run
1. set DOCKER_LE_CONFIG as config JSON string
2. run the script

## Configuration format
```json
{
  "default":{
    "labels":["myname"],
    "token":"LOGSET_TOKEN_DEFAULT"
    },
    "filters":[
      {"labels":["myname","tag1"],"filter":["tag1=a","tag2=1"],"token":"LOGSET_TOKEN_1"},
      {"labels":["myname","tag2"],"filter":["tag1=b","tag2=1"],"token":"LOGSET_TOKEN_2"}
    ]
}
```
Every running container will go through the `filter` rules of `filters`, the logs of the matched container will be sent to logentries API, with the `labels`. 

## Example
```bash
export DOCKER_LE_CONFIG='{"default":{"labels":["myname"],"token":"29a3d766-6555-4715-9d39-78c5a32d5a32"},"filters":[{"labels":["myname","tag1"],"filter":["tag1=a","tag2=1"],"token":"29a3d766-6555-4715-9d39-78c5a32d5a32"},{"labels":["myname","tag2"],"filter":["tag1=b","tag2=1"],"token":"f88530a3-4a07-404b-8695-b06e93e964a2"}]}
node docker2le
```
