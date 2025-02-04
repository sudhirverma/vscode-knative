/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

const IPV6Address = /((?:[0-9A-Fa-f]{1,4}))((?::[0-9A-Fa-f]{1,4}))*::((?:[0-9A-Fa-f]{1,4}))((?::[0-9A-Fa-f]{1,4}))*|((?:[0-9A-Fa-f]{1,4}))((?::[0-9A-Fa-f]{1,4})){7}/gm;
export function hideIPV6Address(message: string): string {
  if (IPV6Address.test(message)) {
    const ipv6Address = message.match(IPV6Address);
    if (ipv6Address && ipv6Address.length !== 0) {
      ipv6Address.forEach((data) => {
        // eslint-disable-next-line no-param-reassign
        message = message.replace(data, 'IPV6 Address ');
      });
    }
  }
  return message;
}

const IpAddress = /(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)+/gm;
export function hideIPAddress(message: string): string {
  if (IpAddress.test(message)) {
    const ipAddress = message.match(IpAddress);
    if (ipAddress && ipAddress.length !== 0) {
      ipAddress.forEach((data) => {
        // eslint-disable-next-line no-param-reassign
        message = message.replace(data, 'IP Address ');
      });
    }
  }
  return hideIPV6Address(message);
}

// eslint-disable-next-line no-useless-escape
const pathMatch = /(?:"([a-zA-Z]\:(\\|\/|\\\\)|\/([^\/]+\/)|.\/|([^\/"]+\/)))([^\\\/\:\*\?\<\>\"\|]+(\\|\/){0,2})+/gm;
export function hidePath(message: string): string {
  if (pathMatch.test(message)) {
    const paths = message.match(pathMatch);
    if (paths && paths.length !== 0) {
      paths.forEach((path) => {
        // eslint-disable-next-line no-param-reassign
        message = message.replace(path, '"local path');
      });
    }
  }
  return hideIPAddress(message);
}

const urlCheck = /(https?:\/\/[^\s]+)/g;
export function hideClusterUrl(message: string): string {
  if (urlCheck.test(message)) {
    // eslint-disable-next-line no-param-reassign
    message = message.replace(urlCheck, 'cluster info ');
  }
  return hidePath(message);
}

const clusterInfo = /lookup\s+([^']+):/;
export function hideClusterInfo(message: string): string {
  if (clusterInfo.test(message)) {
    // eslint-disable-next-line no-param-reassign
    message = message.replace(clusterInfo, 'lookup cluster info: ');
  }
  return hideClusterUrl(message);
}
