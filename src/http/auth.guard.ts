import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (não implementada: vale 0 pontos no enunciado; ver ARCHITECTURE.md).
 * Com um IdP (ex.: Keycloak), aqui o guard validaria o JWT do provedor (assinatura via JWKS, issuer,
 * audience, expiração) e conferiria que o `providerId` do token é o mesmo do corpo da requisição.
 * Os health checks não usam este guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
